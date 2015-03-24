var crypto = require('crypto');
var http = require('http');
var path = require('path');
var url = require('url');

var Proxy = module.exports = function(serviceRegistryClient, routerClient, versionClient) {
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

  this._versionClient.on('change', function(versionObject) {
    self._currentVersion = versionObject.version;
  });

  this._setup();
};

Proxy.prototype._setup = function() {
  var self = this;

  this._versionClient.get(function(err, versionObject) {
    if(err) {
      return;
    }  

    self._currentVersion = versionObject.version;
  });

  this._server.on('upgrade', function(request, socket) {
    if (/^\/peers\//.test(request.url)) {
      self._proxyPeerConnection(request, socket);
    } else {
      self._proxyEventSubscription(request, socket);
    }
  });

  this._server.on('request', function(request, response) {
    var parsed = url.parse(request.url, true);
    
    if (parsed.path === '/') {
      self._serveRoot(request, response)
    } else {
      self._proxyRequest(request, response);
    }
  });

  var self = this;

  self._routerClient.on('change', function(results) {
    console.log('changing:', results);
    var tempRouter = {};
    results.forEach(function(obj) {
      if (!tempRouter.hasOwnProperty(obj.tenantId)) {
        tempRouter[obj.tenantId] = {};
      }

      tempRouter[obj.tenantId][obj.name] = obj.url;
    });

    self._router = tempRouter;
  });

  self._serviceRegistryClient.on('change', function(results) {
    self._processServerList(results);
    //self._shuffleServers();
  });

  this._loadServers(function() {
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
  if (!self._servers[tenantId]) {
    var unallocated = self._unallocated.pop();
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

        if (!self._servers.hasOwnProperty(tenantId)) {
          self._servers[tenantId] = [];
        }

        self._servers[tenantId].push(newRecord);
        self._next(tenantId, cb);
        return;
      })
    } else {
      // handle no more unallocated instances.
    }

    return;
  }

  var servers = self._servers[tenantId].filter(function(server) {
    return server.version === self._currentVersion; // might be a problem here in Vagrant build
  });

  if (!self._serverIndexes.hasOwnProperty(tenantId)) {
    self._serverIndexes[tenantId] = 0;
  }

  var server = servers[self._serverIndexes[tenantId]++ % servers.length];
  if(server) {
    cb(null, server.url);
  } else { 
    cb(new Error('No Server Found'));
  }
 
}

/*Proxy.prototype._shuffleServers = function(tenantId) {
  var counter = this._servers[tenantId].length;
  var temp;
  var index;

  while (counter > 0) {
    index = Math.floor(Math.random() * counter);

    counter--;

    temp = this._servers[tenantId][counter];
    this._servers[tenantId][counter] = this._servers[tenantId][index];
    this._servers[tenantId][index] = temp;
  }
};*/

Proxy.prototype._proxyPeerConnection = function(request, socket) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = this._getTenantId(request);

  var match = /^\/peers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/peers\/(.+)$/.exec(parsed.pathname)[1]);
  }

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
        console.log(err);
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

        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];

        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        if (code === 101) {
          self._routerClient.add(tenantId, targetName, serverUrl, function(err) {
            next();

            timer = setInterval(function() {
              self._routerClient.add(tenantId, targetName, serverUrl, function(err) {});
            }, 60000);
          });
        } else {
          next();
        }

        function next() {
          socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
          upgradeSocket.pipe(socket).pipe(upgradeSocket);

          upgradeSocket.on('close', function() {
            clearInterval(timer);
            self._routerClient.remove(tenantId, targetName, function(err) {
            });
          });

        };
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

Proxy.prototype._proxyEventSubscription = function(request, socket) {
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = this._getTenantId(request);

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

  if (!this._subscriptions.hasOwnProperty(request.url)) {
    this._subscriptions[request.url] = [];
  }

  if (this._cache.hasOwnProperty(request.url)) {
    var key = request.headers['sec-websocket-key'];
    var shasum = crypto.createHash('sha1');
    shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    var serverKey = shasum.digest('base64');

    var responseLine = 'HTTP/1.1 101 Switching Protocols';
    var headers = ['Upgrade: websocket', 'Connection: Upgrade',
     'Sec-WebSocket-Accept: ' + serverKey]

    socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');

    this._subscriptions[request.url].push(socket);
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

  var self = this;
  target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
    var code = targetResponse.statusCode;

    var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];

    var headers = Object.keys(targetResponse.headers).map(function(header) {
      return header + ': ' + targetResponse.headers[header];
    });

    socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');

    self._cache[request.url] = upgradeSocket;
    self._subscriptions[request.url].push(socket);

    socket.on('close', function() {
      var idx = self._subscriptions[request.url].indexOf(socket);
      if (idx >= 0) {
        self._subscriptions[request.url].splice(idx, 1);
      }
      if(self._subscriptions[request.url].length === 0) {
        upgradeSocket.end();
        delete self._subscriptions[request.url];
      }
    });

    upgradeSocket.on('data', function(data) {
      self._subscriptions[request.url].forEach(function(socket) {
        socket.write(data);
      });
    });

    upgradeSocket.on('close', function(data) {
      delete self._cache[request.url];
      if (self._subscriptions[request.url]) {
        self._subscriptions[request.url].forEach(function(socket) {
          socket.end();
        });
      }
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
  var tenantId = this._getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    return;
  }

  if (!this._router.hasOwnProperty(tenantId) || !this._router[tenantId].hasOwnProperty(targetName)) {
    var self = this;
    this._routerClient.get(tenantId, targetName, function(err, serverUrl) {
      if (serverUrl) {
        if (!self._router.hasOwnProperty(tenantId)) {
          self._router[tenantId] = {};
        }

        self._router[tenantId][targetName] = serverUrl;
        next(serverUrl);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
  } else {
    next(this._router[tenantId][targetName]);
  }

  function next(serverUrl) {
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
  };
};

Proxy.prototype._serveRoot = function(request, response) {
  var self = this;

  var tenantId = this._getTenantId(request);

  var body = {
    class: ['root'],
    links: [
      {
        rel: ['self'],
        href: self._parseUri(request)
      }
    ]
  };

  var entities = this._routerClient.findAll(tenantId, function(err, results) {
    if (results) {
      results.forEach(function(peer) {
        body.links.push({
          title: peer.name,
          rel: ['http://rels.zettajs.io/peer'],
          href: self._joinUri(request, '/servers/' + peer.name)
        });
      });
    }

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
  });
};

Proxy.prototype._parseUri = function(request) {
  var xfp = request.headers['x-forwarded-proto'];
  var xfh = request.headers['x-forwarded-host'];
  var protocol;

  if (xfp && xfp.length) {
    protocol = xfp.replace(/\s*/, '').split(',')[0];
  } else {
    protocol = request.connection.encrypted ? 'https' : 'http';
  }

  var host = xfh || request.headers['host'];

  if (!host) {
    var address = request.connection.address();
    host = address.address;
    if (address.port) {
      if (!(protocol === 'https' && address.port === 443) && 
          !(protocol === 'http' && address.port === 80)) {
        host += ':' + address.port
      }
    }
  }

  return protocol + '://' + path.join(host, request.url);
};

Proxy.prototype._joinUri = function(request, pathname) {
  var uri = this._parseUri(request);
  var parsed = url.parse(uri);
  parsed.pathname = path.join(parsed.pathname, pathname).replace(/\\/g, '/');

  return url.format(parsed);
};

Proxy.prototype._getTenantId = function(request) {
  return request.headers['x-apigee-iot-tenant-id'] || 'default';
};
