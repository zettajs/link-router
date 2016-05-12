var http = require('http');
var url = require('url');
var ws = require('ws');
var getTenantId = require('./../../utils/get_tenant_id');
var confirmWs = require('./../../utils/confirm_ws');

var PeerManagement = module.exports = function(proxy) {
  this.proxy = proxy;
  
  // keep track of ws connections
  this._cache = {};
};

PeerManagement.prototype.handler = function(request, socket, receiver) {
  var self = this;
  var tenantId = getTenantId(request);

  // send upgrade response
  confirmWs(request, socket);

  var sender = new ws.Sender(socket);
  sender.on('error', function(err) {
    console.error('sender error:', err);
  });

  var parsed = url.parse(request.url);
  if (parsed.path === '/peer-management') {
    var cache = this._getCacheObj(tenantId);
    socket.on('error', function(err) {
      console.error('Client PeerManagement Ws Error:', tenantId, err);
    });
    socket.on('close', function() {
      // client closed
      var idx = cache.clients.indexOf(socket);
      if (idx >= 0) {
        cache.clients.splice(idx, 1);
      }

      if (cache.clients.length === 0) {
        // abort all pending http req
        cache.pending.forEach(function(req) {
          req.abort();
        });
        
        // no more clients attached. close targets
        Object.keys(cache.targets).forEach(function(targetUrl) {
          // guard against clients closing before upgrade event is sent
          if (cache.targets[targetUrl] && cache.targets[targetUrl].end) {
            cache.targets[targetUrl].end();
          }
        })
        cache.remove();
      }
    });
    

    var servers = this.proxy.activeTargets(tenantId);
    cache.clients.push(socket);


    // If not first client don't resubscribe to targets
    if (cache.clients.length > 1) {
      return;
    }

    // Handle new targets being allocated for tenant
    var handleNewTargets = function() {
      self.proxy.activeTargets(tenantId).forEach(function(server) {
        if (!cache.targets.hasOwnProperty(server.url)) {
          self._subscribeToTarget(request, cache, server);
        }
      });
    };
    self.proxy.on('services-update', handleNewTargets);
    cache.finished = function() {
      self.proxy.removeListener('services-update', handleNewTargets);
    };
    
    servers.forEach(function(server) {
      self._subscribeToTarget(request, cache, server);
    });
  } else {
    // disconnect websocket
    sender.close(1001, null, false, function(err) {
      socket.end();
    });
  }
  
};


PeerManagement.prototype._subscribeToTarget = function(request, cache, target) {
  var server = url.parse(target.url);
  var parsed = url.parse(request.url);
  var options = {
    method: request.method,
    headers: request.headers,
    hostname: server.hostname,
    port: server.port,
    path: parsed.path
  };

  cache.targets[target.url] = null;

  var target = http.request(options);
  cache.pending.push(target);

  function removeFromPending() {
    var idx = cache.pending.indexOf(target);
    if (idx >= 0) {
      cache.pending.splice(idx, 1);
    }    
  }

  target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
    removeFromPending();
    cache.targets[target.url] = upgradeSocket;

    upgradeSocket.on('data', function(data) {
      cache.clients.forEach(function(client) {
        client.write(data);
      });
    });

    upgradeSocket.on('close', function() {
      delete cache.targets[target.url];
      // close all clients
      cache.clients.forEach(function(client) {
        client.end();
      });
    });

    upgradeSocket.on('error', function(err) {
      console.error('Client PeerManagement Target Ws Error:', target.url, err);
    });
  });

  target.on('error', function(err) {
    removeFromPending();
  });

  target.end();
};

PeerManagement.prototype._getCacheObj = function(tenantId) {
  var self = this;
  if (!this._cache[tenantId]) {
    this._cache[tenantId] = {
      clients: [], // list of client sockets
      targets: {}, // <targetUrl>: socket
      pending: [], // list of pending http req assoc to this query
      remove: function() {
        if (self._cache[tenantId].finished) {
          self._cache[tenantId].finished();
        }
        delete self._cache[tenantId];
      },
      finished: null // allow to be updated
    };
  }

  return this._cache[tenantId];
};
