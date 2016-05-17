var url = require('url');
var http = require('http');
var async = require('async');
var ws = require('ws');
var getBody = require('./../../utils/get_body');
var getTenantId = require('./../../utils/get_tenant_id');
var confirmWs = require('./../../utils/confirm_ws');

var Handler = module.exports = function(proxy) {
  var self = this;
  this.proxy = proxy;
  this._cache = {};

  setInterval(function() {
    Object.keys(self._cache).forEach(function(tenant) {
      var count = 0;
      Object.keys(self._cache[tenant]).forEach(function(query) {
        var obj = self._cache[tenant][query];
        count += obj.clients.length;
      });

      self.proxy._statsClient.gauge('ws.query', count, { tenant: tenant });
    });
  }, 5000);
};

Handler.prototype.handler = function(request, socket, receiver) {
  var self = this;
  var tenantId = getTenantId(request);
  var parsed = url.parse(request.url, true);
  var queryHash = parsed.query.topic;
  var cache = this._getCacheObj(tenantId, queryHash);

  self.proxy._statsClient.increment('http.req.wsquery.status.1xx', { tenant: tenantId });

  socket.on('error', function(err) {
    console.error('Client Query Ws Error:', tenantId, err);
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
      });
      cache.remove();
    }
  });
  
  var servers = this.proxy.activeTargets(tenantId);

  confirmWs(request, socket);
  cache.clients.push(socket);

  // for non first clients, init ws with filling in with http data.
  if (cache.clients.length > 1) {
    this._syncClientWithTargets(cache, request, socket, servers);
    return;
  }

  // needed later to subscribe to newly allocated targets
  cache._initialReq = request;

  var handleNewTargets = function() {
    self.proxy.activeTargets(tenantId).forEach(function(server) {
      if (!cache.targets.hasOwnProperty(server.url)) {
        self._subscribeToTarget(cache, server);
      }
    });
  };

  self.proxy.on('services-update', handleNewTargets);
  cache.finished = function() {
    self.proxy.removeListener('services-update', handleNewTargets);
 };
  
  servers.forEach(function(server) {
    self._subscribeToTarget(cache, server);
  });
};

Handler.prototype._subscribeToTarget = function(cache, target) {
  var server = url.parse(target.url);
  var request = cache._initialReq;
  var parsed = url.parse(request.url);
  var options = {
    method: request.method,
    headers: request.headers,
    hostname: server.hostname,
    port: server.port,
    path: parsed.path
  };

  cache.targets[target.url] = null;

  var req = http.request(options);
  cache.pending.push(req);

  function removeFromPending() {
    var idx = cache.pending.indexOf(req);
    if (idx >= 0) {
      cache.pending.splice(idx, 1);
    }    
  }

  req.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
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
      console.error('Client Query Target Ws Error:', target.url, err);
    });
  });

  req.on('error', function(err) {
    removeFromPending();
  });

  req.end();
};

Handler.prototype._syncClientWithTargets = function(cache, request, socket, servers, callback) {
  var self = this;
  
  if (typeof callback !== 'function') {
    callback = function() {};
  }
  
  var parsed = url.parse(request.url, true);
  servers = servers.map(function(obj) { return obj.url; });

  var options = {
    method: 'GET',
    headers: {
    },
    path: url.format({
      pathname: '/',
      query: {
        server: '*',
        ql: parsed.query.topic.split('query/')[1]
      }
    })
  };

  this.proxy.scatterGatherActive(servers, request, options, function(err, results) {
    if (err) {
      return callback(err);
    }

    // include only 200 status code responses
    var devicePaths = [];
    results.forEach(function(ret) {
      if (ret.err || ret.res.statusCode !== 200 || !ret.json) {
        return;
      }

      ret.json.entities.forEach(function(entity) {
        devicePaths.push(entity.links.filter(function(l) { return l.rel.indexOf('self') >= 0;})[0].href);
      });

      var options = {
        method: 'GET',
        headers: {
        },
        useServersPath: true
      };
      
      if (request.headers['origin']) {
        options.headers.origin = request.headers['origin'];
      }
      
      if (request.headers['host']) {
        options.headers.host = request.headers['host'];
      }

      self.proxy.scatterGatherActive(devicePaths, request, options, function(err, results) {
        if (err) {
          return callback(err);
        }
        
        var sender = new ws.Sender(socket);
        sender.once('error', function(err) {
          console.error('sender error:', err);
        });
        results.forEach(function(ret) {
          if (ret.err || ret.res.statusCode !== 200 || !ret.json) {
            return;
          }

          sender.send(JSON.stringify(ret.json));
        });
      });
    });    
  });
};

Handler.prototype._getCacheObj = function(tenantId, queryHash) {
  var self = this;
  if (!this._cache[tenantId]) {
    this._cache[tenantId] = {};
  }
  
  if (!this._cache[tenantId][queryHash]) {
    this._cache[tenantId][queryHash] = {
      clients: [], // list of client sockets
      targets: {}, // <targetUrl>: socket
      pending: [], // list of pending http req assoc to this query
      remove: function() {
        if (self._cache[tenantId][queryHash].finished) {
          self._cache[tenantId][queryHash].finished();
        }
        delete self._cache[tenantId][queryHash];
        if (Object.keys(self._cache[tenantId]).length === 0) {
          delete self._cache[tenantId];
        }
      },
      finished: null // allow to be updated
    };
  }

  return this._cache[tenantId][queryHash];
};

