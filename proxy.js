// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var http = require('http');
var url = require('url');
var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var Rels = require('zetta-rels');
var WsQueryHandler = require('./query_ws_handler.js');
var HttpQueryHandler = require('./query_http_handler.js');
var PeerManagementHandler = require('./peer_management_handler');
var TargetAllocation = require('./target_allocation');
var RouterStateHandler = require('./proxy_state_handler');
var WsEventStreamHandler = require('./event_stream_ws_handler');
var parseUri = require('./parse_uri');
var joinUri = require('./join_uri');
var getBody = require('./get_body');
var getTenantId = require('./get_tenant_id');
var confirmWs = require('./confirm_ws');
var statusCode = require('./status_code');
var sirenResponse = require('./siren_response');
var RouterCache = require('./router_cache');
var ws = require('ws');

function parseSubscription(hash) {
  var arr = hash.split(':');
  return {
    tenantId: decodeURIComponent(arr[0]),
    targetName: decodeURIComponent(arr[1]),
    targetHost: decodeURIComponent(arr[2]),
    url: decodeURIComponent(arr[3])
  };
}

var Proxy = module.exports = function(serviceRegistryClient, routerClient, versionClient, statsClient, targetMonitor) {

  EventEmitter.call(this);
  var self = this;
  this._serviceRegistryClient = serviceRegistryClient;
  this._routerClient = routerClient;
  this._versionClient = versionClient;
  this._statsClient = statsClient;
  this._currentVersion = null;
  this._server = http.createServer();
  this._routerCache = new RouterCache();
  this._cache = {};
  this._subscriptions = {};
  this._servers = {};
  this._peerSockets = [];
  this._targetMonitor = targetMonitor;
  this._targetAllocation = new TargetAllocation(this);

  this.peerActivityTimeout = 60000;

  this._setup();
};
util.inherits(Proxy, EventEmitter);

Proxy.prototype._setup = function() {
  var self = this;

  var wsQueryHandler = new WsQueryHandler(this);
  var httpQueryHandler = new HttpQueryHandler(this);
  var routerStateHandler= new RouterStateHandler(this);
  var peerManagementHandler = new PeerManagementHandler(this);
  var wsEventStreamHandler = new WsEventStreamHandler(this);

  this._server.on('upgrade', function(request, socket) {

    socket.allowHalfOpen = false;

    if (/^\/peers\//.test(request.url)) {
      self._proxyPeerConnection(request, socket);
    } else {
      var receiver = new ws.Receiver();
      socket.on('data', function(buf) {
        receiver.add(buf);
      });

      // request from client to close websocket
      receiver.onclose = function(code, data, flags) {
        socket.end();
      };

      // handle ping requests
      receiver.onping = function(data, flags) {
        var sender = new ws.Sender(socket);
        sender.pong(data, { binary: flags.binary === true }, true);
      };

      socket.once('close', function() {
        receiver.cleanup();
      });

      if (/^\/events/.test(request.url)) {
        var parsed = url.parse(request.url, true);
        if(parsed.query.hasOwnProperty('topic')) {
          wsQueryHandler.wsQuery(request, socket, receiver);
        } else {
         wsEventStreamHandler.connection(request, socket, receiver);
        }
      } else if (/^\/peer-management/.test(request.url)) {
        peerManagementHandler.routeWs(request, socket, receiver);
      } else {
        self._proxyEventSubscription(request, socket, receiver);
      }
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
    } else if (parsed.pathname === '/state') {
      routerStateHandler.request(request, response);
    } else if (/^\/peer-management/.test(request.url)) {
      peerManagementHandler.routeHttp(request, response, parsed);
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
    self.emit('version-update', self._currentVersion);
  });

  self._routerClient.on('change', function(results) {
    // Clear cache b/c we have full list of router from results
    self._routerCache.reset();

    results.forEach(function(obj) {
      self._routerCache.set(obj.tenantId, obj.name, obj.url);
    });
    
    self._disconnectStaleWsClients();
    self.emit('router-update', self._routerCache);
  });

  self._serviceRegistryClient.on('change', function(results) {
    self._processServerList(results);
    self.emit('services-update');
  });

  this._loadServers(function() {
    self.emit('services-update');
  });


  setInterval(function() {
    var counts = {};
    self._peerSockets.forEach(function(peerObj) {
      if (!counts[peerObj.tenantId]) {
        counts[peerObj.tenantId] = 0;
      }
      counts[peerObj.tenantId]++;
    });

    Object.keys(counts).forEach(function(tenant) {
      self._statsClient.gauge('ws.peers', counts[tenant], { tenant: tenant });
    });

    var wsCounts = {};
    Object.keys(self._subscriptions).forEach(function(topicHash) {
      var parsed = parseSubscription(topicHash);
      if (!wsCounts[parsed.tenantId]) {
        wsCounts[parsed.tenantId] = 0;
      }
      wsCounts[parsed.tenantId]++;
    });
    Object.keys(wsCounts).forEach(function(tenant) {
      self._statsClient.gauge('ws.event', wsCounts[tenant], { tenant: tenant });
    });

  }, 5000);

};

Proxy.prototype._processServerList = function(servers) {
  var tempServers = {}; 
  servers.forEach(function(server) {
    if (!server.tenantId) {
      return;
    }

    if (!tempServers.hasOwnProperty(server.tenantId)) {
      tempServers[server.tenantId] = [];
    }
    tempServers[server.tenantId].push(server);
  });

  this._servers = tempServers;
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
  return this._targetAllocation.lookup(tenantId, cb);
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

  self._statsClient.increment('http.req.peer', { tenant: tenantId });

  this._routerClient.get(tenantId, targetName, function(err, peer) {
    if (err && (!err.error || err.error.errorCode !== 100) ) {
      socket.end('HTTP/1.1 500 Server Error\r\n\r\n\r\n');
      self._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
      return;
    }
    
    if (peer) {
      socket.end('HTTP/1.1 409 Peer Conflict\r\n\r\n\r\n');
      self._statsClient.increment('http.req.peer.status.4xx', { tenant: tenantId });
      return;
    }
    
    self._next(tenantId, function(err, serverUrl) {
      if(err) {
        console.error('Peer Socket Failed to allocated target:', err);
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        self._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
        return;
      }

      if (!serverUrl) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        self._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
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

      // Handle non 101 responses from target
      target.on('response', function(targetResponse) {
        var code = targetResponse.statusCode;
        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
        targetResponse.pipe(socket);
      });
      
      target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
        var timer = null;
        var code = targetResponse.statusCode;
        var peerObj = { tenantId: tenantId,
                        targetName: targetName,
                        upgradeSocket: upgradeSocket,
                        socket: socket
                      };

        var cleanup = function() {
          clearInterval(timer);          
          var idx = self._peerSockets.indexOf(peerObj);
          if (idx >= 0) {
            self._peerSockets.splice(idx, 1);
          }
          self._routerClient.remove(tenantId, targetName, function(err) {}); 
        };

        self._statsClient.increment('http.req.peer.status.1xx', { tenant: tenantId });

        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        upgradeSocket.on('error', function(err) {
          console.error('Target Socket Error:', tenantId, targetName, err);
          cleanup();
        });
        upgradeSocket.on('timeout', function() {
          console.error('Target Socket Timeout:', tenantId, targetName);
          upgradeSocket.destroy();
          socket.end();
        });
        upgradeSocket.setTimeout(self.peerActivityTimeout);

        socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
        upgradeSocket.pipe(socket).pipe(upgradeSocket);

        socket.on('close', cleanup);
        upgradeSocket.on('close', cleanup);

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
        self._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
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

  // make sure target exists in router and is the same as what is subscribed to
  Object.keys(this._cache).forEach(function(hash) {
    var obj = parseSubscription(hash);
    var serverUrl = self._routerCache.get(obj.tenantId, obj.targetName);
    if (serverUrl === undefined || serverUrl !== obj.targetHost) {
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
    self._statsClient.increment('http.req.event.status.4xx', { tenant: tenantId });
    var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
    socket.end(responseLine);
    return;
  }

  this.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      self._statsClient.increment('http.req.event.status.5xx', { tenant: tenantId });
      var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
      socket.end(responseLine);
      return;
    }

    if (!serverUrl) {
      self._statsClient.increment('http.req.event.status.4xx', { tenant: tenantId });
      var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
      socket.end(responseLine);
      return;
    }

    var urlHash = [tenantId, targetName, serverUrl, request.url].map(encodeURIComponent).join(':');
    if (!self._subscriptions.hasOwnProperty(urlHash)) {
      self._subscriptions[urlHash] = [];
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

    if (self._cache.hasOwnProperty(urlHash)) {
      confirmWs(request, socket);
      self._subscriptions[urlHash].push(socket);
      self._statsClient.increment('http.req.event.status.1xx', { tenant: tenantId });
      cleanup = function() {
        removeSocketFromCache();
      };

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

    cleanup = function () {
      target.abort();
    };

    target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
      var code = targetResponse.statusCode;
      var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
      var headers = Object.keys(targetResponse.headers).map(function(header) {
        return header + ': ' + targetResponse.headers[header];
      });

      self._statsClient.increment('http.req.event.status.1xx', { tenant: tenantId });
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
  });
};

Proxy.prototype._proxyRequest = function(request, response) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);
  
  var startTime = new Date().getTime();

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    self._statsClient.increment('http.req.proxy.status.4xx', { tenant: tenantId });
    response.statusCode = 404;
    response.end();
    return;
  }
  
  this.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      self._statsClient.increment('http.req.proxy.status.4xx', { tenant: tenantId });
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

    // close target req if client is closed before target finishes
    response.on('close', function() {
      target.abort();
    });

    target.on('response', function(targetResponse) {
      response.statusCode = targetResponse.statusCode;

      Object.keys(targetResponse.headers).forEach(function(header) {
        response.setHeader(header, targetResponse.headers[header]);
      });

      var duration = new Date().getTime() - startTime;
      self._statsClient.timing('http.req.proxy', duration, { tenant: tenantId, targetName: targetName });
      self._statsClient.increment('http.req.proxy.status.' + statusCode(response.statusCode), { tenant: tenantId, targetName: targetName });

      targetResponse.pipe(response);
    });

    target.on('error', function() {
      self._statsClient.increment('http.req.proxy.status.5xx', { tenant: tenantId, targetName: targetName });
      response.statusCode = 500;
      response.end();
    });

    request.pipe(target);    
  });
};

Proxy.prototype._serveRoot = function(request, response) {
  var self = this;
  var tenantId = getTenantId(request);

  var startTime = new Date().getTime();

  var body = {
    class: ['root'],
    links: [
      {
        rel: ['self'],
        href: parseUri(request)
      },
      {
        rel: [ Rels.peerManagement ],
        href: joinUri(request, '/peer-management')
      },
      {
        rel: [ Rels.events ],
        href: joinUri(request, '/events').replace(/^http/,'ws')
      }
    ]
  };

  var clientAborted = false;
  request.on('close', function() {
    clientAborted = true;
  });

  var entities = this._routerClient.findAll(tenantId, function(err, results) {
    if (clientAborted) {
      return;
    }

    if (results) {
      results.forEach(function(peer) {
        body.links.push({
          title: peer.name,
          rel: [Rels.peer, Rels.server],
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

    var duration = new Date().getTime()-startTime;
    self._statsClient.timing('http.req.root', duration, { tenant: tenantId });
    self._statsClient.increment('http.req.root.status.2xx', { tenant: tenantId });

    sirenResponse(response, 200, body);
  });
};


// Return all targets for a tenantId with the current active version and any targets that have
// peers currently connected.
Proxy.prototype.activeTargets = function(tenantId) {
  var self = this;
  var activeServers = [];


  // Get all target servers from routerCache
  this._routerCache.keys(tenantId).forEach(function(obj) {
    activeServers.push(self._routerCache.get(obj.tenantId, obj.targetName));
  });

  if (!this._servers.hasOwnProperty(tenantId)) {
    return activeServers;
  }
  
  return this._servers[tenantId].filter(function(server) {
    if (server.version === self._currentVersion || activeServers.indexOf(server.url) >= 0) {
      // Only return online servers
      return self._targetMonitor.status(server.url);
    }
  });
};


// Return all targets for a tenantId with the current version
Proxy.prototype.targets = function(tenantId) {
  var self = this;

  if (!this._servers.hasOwnProperty(tenantId)) {
    return [];
  }

  return this._servers[tenantId].filter(function(server) {
    return server.version === self._currentVersion && self._targetMonitor.status(server.url);
  });
};


Proxy.prototype.lookupPeersTarget = function(tenantId, targetName, cb) {
  var self = this;
  var serverUrl = this._routerCache.get(tenantId, targetName);
  if (serverUrl === undefined) {
    this._routerClient.get(tenantId, targetName, function(err, serverUrl) {
      if (serverUrl) {
        self._routerCache.set(tenantId, targetName, serverUrl);
        cb(null, serverUrl);
      } else {
        cb(new Error('No server found.'));
      }
    });
  } else {
    cb(null, serverUrl);
  }
}
