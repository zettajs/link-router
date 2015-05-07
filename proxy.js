var http = require('http');
var url = require('url');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var WsQueryHandler = require('./query_ws_handler.js');
var HttpQueryHandler = require('./query_http_handler.js');
var parseUri = require('./parse_uri');
var joinUri = require('./join_uri');
var getBody = require('./get_body');
var getTenantId = require('./get_tenant_id');
var confirmWs = require('./confirm_ws');

var Proxy = module.exports = function(serviceRegistryClient, routerClient, versionClient) {
  EventEmitter.call(this);
  var self = this;
  this._serviceRegistryClient = serviceRegistryClient;
  this._routerClient = routerClient;
  this._versionClient = versionClient;
  this._currentVersion = null;
  this._serverIndexes = {};
  this._server = http.createServer();
  this._router = {};
  this._cache = {};
  this._subscriptions = {};
  this._servers = {};
  this._hasLoadedServers = false;
  this._unallocated = [];
  this._peerSockets = [];

  this._setup();
};
util.inherits(Proxy, EventEmitter);

Proxy.prototype._setup = function() {
  var self = this;

  var wsQueryHandler = new WsQueryHandler(this);
  var httpQueryHandler = new HttpQueryHandler(this);

  this._server.on('upgrade', function(request, socket) {
    socket.allowHalfOpen = false;
    if (/^\/peers\//.test(request.url)) {
      self._proxyPeerConnection(request, socket);
    } else if (/^\/events\?/.test(request.url)) {
      wsQueryHandler.wsQuery(request, socket);
    } else {
      self._proxyEventSubscription(request, socket);
    }
  });

  this._server.on('request', function(request, response) {
    var parsed = url.parse(request.url, true);
    if (parsed.pathname === '/') {
      if (parsed.query.ql) {
        httpQueryHandler.serverQuery(request, response, parsed);
      } else {
        self._serveRoot(request, response);
      }
    } else {
      self._proxyRequest(request, response);
    }
  });

  this._versionClient.on('change', function(versionObject) {
    self._currentVersion = versionObject.version;
  });

  this._versionClient.get(function(err, versionObject) {
    if(err) {
      return;
    }  

    self._currentVersion = versionObject.version;
    self.emit('version-update', self._router);
  });

  self._routerClient.on('change', function(results) {
    var tempRouter = {};
    results.forEach(function(obj) {
      if (!tempRouter.hasOwnProperty(obj.tenantId)) {
        tempRouter[obj.tenantId] = {};
      }

      tempRouter[obj.tenantId][obj.name] = obj.url;
    });

    self._router = tempRouter;
    self._disconnectStaleWsClients();
    self.emit('router-update', self._router);
  });

  self._serviceRegistryClient.on('change', function(results) {
    self._processServerList(results);
    self.emit('services-update', self._servers, self._unallocated);
  });

  this._loadServers(function() {
    self.emit('services-update', self._servers, self._unallocated);
  });
};

Proxy.prototype._processServerList = function(servers) {
  var tempServers = {}; 
  var unallocated = [];
  servers.forEach(function(server) {
    if (!server.tenantId) {
      unallocated.push(server);
      return;
    }

    if (!tempServers.hasOwnProperty(server.tenantId)) {
      tempServers[server.tenantId] = [];
    }
    tempServers[server.tenantId].push(server);
  });

  this._servers = tempServers;
  this._unallocated = unallocated;
};

Proxy.prototype._loadServers = function(cb) {
  var self = this;
  this._serviceRegistryClient.find('cloud-target', function(err, results) {
    // TODO: Add some resiliency here.
    if (err) {
      if (cb) {
        cb(err);
      }
      return;
    }

    if (!results) {
      if (cb) {
        cb();
      }
      return;
    }

    self._processServerList(results);
    //self._shuffleServers();

    if (cb) {
      cb();
    }
  });
};

Proxy.prototype._next = function(tenantId, cb) {
  var self = this;

  if (!self._servers.hasOwnProperty(tenantId)) {
    self._servers[tenantId] = [];
  }

  if (!self._serverIndexes.hasOwnProperty(tenantId)) {
    self._serverIndexes[tenantId] = 0;
  }

  // filter servers by version
  var servers = self._servers[tenantId].filter(function(server) {
    return server.version === self._currentVersion;
  });

  // return the next unallocated server filtered by current version
  function nextUnallocated() {
    var ret = undefined;
    self._unallocated.some(function(server, idx, arr) {
      if (server.version === self._currentVersion) {
        ret = arr[idx];
        arr.splice(idx, 1);
        return true;
      }
    });
    return ret;
  }

  if (servers.length < 2) {
    var unallocated = nextUnallocated();
    if (unallocated) {
      var newRecord = {
        url: unallocated.url,
        tenantId: tenantId,
        created: unallocated.created,
        version: unallocated.version
      };

      self._serviceRegistryClient.allocate('cloud-target', unallocated, newRecord, function(err) {
        if (err) {
          self._next(tenantId, cb);
          return;
        }
        
        // handle race condition if service registy update event run's before cb is called
        if (!self._servers[tenantId]) {
          self._servers[tenantId] = [];
        }

        self._servers[tenantId].push(newRecord);
        self._next(tenantId, cb);
        return;
      });
      return;
    } else if (servers.length > 0) {
      // TODO: handle cases where there are not any more instances to allocate.
      // continue to use self._servers[tenantId] for servers
    } else {
      cb(new Error('No available target servers for tenant `' + tenantId + '`.'));
      return;
    }
  }

  var server = servers[self._serverIndexes[tenantId]++ % servers.length];
  if(server) {
    cb(null, server.url);
  } else { 
    cb(new Error('No Server Found'));
  }
 
}

Proxy.prototype._proxyPeerConnection = function(request, socket) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/peers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/peers\/(.+)$/.exec(parsed.pathname)[1]);
  }

  socket.on('error', function(err) {
    console.error('Peer Socket Error:', tenantId, targetName, err);
  });

  this._routerClient.get(tenantId, targetName, function(err, peer) {
    if (err && err.error.errorCode !== 100) {
      socket.end('HTTP/1.1 500 Server Error\r\n\r\n\r\n');
      return;
    }
    
    if (peer) {
      socket.end('HTTP/1.1 409 Peer Conflict\r\n\r\n\r\n');
      return;
    }
    
    self._next(tenantId, function(err, serverUrl) {
      if(err) {
        console.error('Peer Socket Failed to allocated target:', err);
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        return;
      }

      if (!serverUrl) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        return;
      }

      var server = url.parse(serverUrl);

      var options = {
        method: request.method,
        headers: request.headers,
        hostname: server.hostname,
        port: server.port,
        path: parsed.path
      };

      var target = http.request(options);
      target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
        var timer = null;
        var code = targetResponse.statusCode;
        var peerObj = { tenantId: tenantId,
                        targetName: targetName,
                        upgradeSocket: upgradeSocket,
                        socket: socket
                      };


        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        socket.on('error', function(err) {
          console.error('Target Socket Error:', tenantId, targetName, err);
        });

        socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
        upgradeSocket.pipe(socket).pipe(upgradeSocket);

        socket.on('close', cleanup);
        upgradeSocket.on('close', cleanup);

        function cleanup() {
          clearInterval(timer);          
          var idx = self._peerSockets.indexOf(peerObj);
          if (idx >= 0) {
            self._peerSockets.splice(idx, 1);
          }
          self._routerClient.remove(tenantId, targetName, function(err) {}); 
        }

        if (code === 101) {
          self._peerSockets.push(peerObj);
          self._routerClient.add(tenantId, targetName, serverUrl, function(err) {});
          timer = setInterval(function() {
            self._routerClient.add(tenantId, targetName, serverUrl, function(err) {});
          }, 60000);
        } else {
          socket.end();
        }
      });

      target.on('error', function() {
        var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
        socket.end(responseLine);
      });

      request.pipe(target);
    });


  });
};

Proxy.prototype.listen = function() {
  this._server.listen.apply(this._server, Array.prototype.slice.call(arguments));
};

// disconnects client ws where the hub no longer exists or 
// exists on a different target server
Proxy.prototype._disconnectStaleWsClients = function() {
  var self = this;

  function parseSubscription(hash) {
    var arr = hash.split(':');
    return {
      tenantId: decodeURIComponent(arr[0]),
      targetName: decodeURIComponent(arr[1]),
      targetHost: decodeURIComponent(arr[2]),
      url: decodeURIComponent(arr[3])
    };
  }

  // make sure target exists in router and is the same as what is subscribed to
  Object.keys(this._cache).forEach(function(hash) {
    var obj = parseSubscription(hash);
    if (!self._router[obj.tenantId] || !self._router[obj.tenantId][obj.targetName] || self._router[obj.tenantId][obj.targetName] !== obj.tagetHost) {
      // end subscription to zetta target, will close all clients
      self._cache[hash].end();
    }
  });
};

Proxy.prototype._proxyEventSubscription = function(request, socket) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
    socket.end(responseLine);
    return;
  }

  if (!this._router[tenantId] || !this._router[tenantId][targetName]) {
    var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
    socket.end(responseLine);
    return;
  }

  var urlHash = [tenantId, targetName, this._router[tenantId][targetName], request.url].map(encodeURIComponent).join(':');
  if (!this._subscriptions.hasOwnProperty(urlHash)) {
    this._subscriptions[urlHash] = [];
  }

  socket.on('error', function(err) {
    console.error('Client Socket Error:', tenantId, targetName, err);
  });

  function removeSocketFromCache() {
    var idx = self._subscriptions[urlHash].indexOf(socket);
    if (idx >= 0) {
      self._subscriptions[urlHash].splice(idx, 1);
    }
    
    if (self._subscriptions[urlHash].length === 0) {
      if (self._cache[urlHash]) {
        self._cache[urlHash].end();
      }
      delete self._subscriptions[urlHash];
      delete self._cache[urlHash];
    }
  }

  var cleanup = function() {};

  socket.on('close', function() {
    cleanup();
  });

  if (this._cache.hasOwnProperty(urlHash)) {
    confirmWs(request, socket);
    this._subscriptions[urlHash].push(socket);
    cleanup = function() {
      removeSocketFromCache();
    };

    return;
  }

  var server = url.parse(this._router[tenantId][targetName]);
  var options = {
    method: request.method,
    headers: request.headers,
    hostname: server.hostname,
    port: server.port,
    path: parsed.path
  };

  var target = http.request(options);

  cleanup = function () {
    target.abort();
  };

  target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
    var code = targetResponse.statusCode;
    var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
    var headers = Object.keys(targetResponse.headers).map(function(header) {
      return header + ': ' + targetResponse.headers[header];
    });

    socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');

    self._cache[urlHash] = upgradeSocket;
    self._subscriptions[urlHash].push(socket);

    cleanup = function() {
      removeSocketFromCache();
    };

    upgradeSocket.on('data', function(data) {
      if (self._subscriptions[urlHash]) {
        self._subscriptions[urlHash].forEach(function(socket) {
          socket.write(data);
        });
      }
    });

    upgradeSocket.on('close', function() {
      delete self._cache[urlHash];
      if (self._subscriptions[urlHash]) {
        self._subscriptions[urlHash].forEach(function(socket) {
          socket.end();
        });
      }
    });

    upgradeSocket.on('error', function(err) {
      console.error('Target Ws Socket Error:', tenantId, targetName, err);
    });
  });

  target.on('error', function() {
    var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
    socket.end(responseLine);
  });

  request.pipe(target);
};

Proxy.prototype._proxyRequest = function(request, response) {
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    return;
  }

  this.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      response.statusCode = 404;
      response.end();
      return;
    }

    var server = url.parse(serverUrl);

    var options = {
      method: request.method,
      headers: request.headers,
      hostname: server.hostname,
      port: server.port,
      path: parsed.path
    };

    var target = http.request(options);

    target.on('response', function(targetResponse) {
      response.statusCode = targetResponse.statusCode;

      Object.keys(targetResponse.headers).forEach(function(header) {
        response.setHeader(header, targetResponse.headers[header]);
      });

      targetResponse.pipe(response);
    });

    target.on('error', function() {
      response.statusCode = 500;
      response.end();
    });

    request.pipe(target);    
  });
};

Proxy.prototype._serveRoot = function(request, response) {
  var self = this;

  var tenantId = getTenantId(request);

  var body = {
    class: ['root'],
    links: [
      {
        rel: ['self'],
        href: parseUri(request)
      }
    ]
  };

  var entities = this._routerClient.findAll(tenantId, function(err, results) {
    if (results) {
      results.forEach(function(peer) {
        body.links.push({
          title: peer.name,
          rel: ['http://rels.zettajs.io/peer'],
          href: joinUri(request, '/servers/' + peer.name)
        });
      });
    }

    body.actions = [
      { 
        name: 'query-devices',
        method: 'GET',
        href: parseUri(request),
        type: 'application/x-www-form-urlencoded',
        fields: [
          { name: 'server', type: 'text' },
          { name: 'ql', type: 'text' }
        ]
      }
    ];

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
  });
};


// Return all targets for a tenantId with the current active version and any targets that have
// peers currently connected.
Proxy.prototype.activeTargets = function(tenantId) {
  var self = this;
  
  var activeServers = [];
  if (this._router.hasOwnProperty(tenantId)) {
    Object.keys(self._router[tenantId]).forEach(function(peerName) {
      activeServers.push(self._router[tenantId][peerName]);
    });
  }
  
  if (!this._servers.hasOwnProperty(tenantId)) {
    return [];
  }
  
  return this._servers[tenantId].filter(function(server) {
    return server.version === self._currentVersion || activeServers.indexOf(server.url) >= 0;
  });
};


Proxy.prototype.lookupPeersTarget = function(tenantId, targetName, cb) {
  var self = this;
  if (!this._router.hasOwnProperty(tenantId) || !this._router[tenantId].hasOwnProperty(targetName)) {
    this._routerClient.get(tenantId, targetName, function(err, serverUrl) {
      if (serverUrl) {
        if (!self._router.hasOwnProperty(tenantId)) {
          self._router[tenantId] = {};
        }

        self._router[tenantId][targetName] = serverUrl;
        cb(null, serverUrl);
      } else {
        cb(new Error('No server found.'));
      }
    });
  } else {
    cb(null, this._router[tenantId][targetName]);
  }
}
