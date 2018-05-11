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
var async = require('async');
var ws = require('ws');
var getBody = require('./get_body');
var getTenantId = require('./get_tenant_id');
var sirenResponse = require('./siren_response');
var parseUri = require('./parse_uri');
var statusCode = require('./status_code');
var confirmWs = require('./confirm_ws');

var PeerManagement = module.exports = function(proxy) {
  this.proxy = proxy;

  // keep track of ws connections
  this._cache = {};
};

PeerManagement.prototype.routeHttp = function(request, response, parsed) {
  if (!(/^\/peer-management\/(.+)$/.exec(request.url))) {
    // only allow GET on the root
    if (request.method !== 'GET') {
      self.proxy._statsClient.increment('http.req.peer-management.status.4xx', { tenant: tenantId });
      response.statusCode = 405;
      response.end();
      return;
    }
    this.serveRoot(request, response, parsed);
  } else {
    this.proxyReq(request, response, parsed);
  }
};

PeerManagement.prototype.proxyReq = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);
  var startTime = new Date().getTime();

  // Can either be hub_name or a connection id
  var lookupId = decodeURIComponent(/^\/peer-management\/(.+)$/.exec(parsed.pathname)[1]);
  

  // HTTP GET /peer-managment/<hub_name> - Lookup etcd
  if (request.method === 'GET') {
    // lookup target by hub_name
    this.proxy.lookupPeersTarget(tenantId, lookupId, function(err, serverUrl) {
      if (err) {
        self.proxy._statsClient.increment('http.req.peer-management.status.4xx', { tenant: tenantId });
        response.statusCode = 404;
        response.end();
        return;
      }

      self._proxyReq(request, response, parsed, serverUrl);
    });
  } else {
    // HTTP POST|PUT|DELETE /peer-management/<connection_id> - Locate in all active targets

    // Find the target with the connection id
    this._locateConnectionIdTarget(tenantId, lookupId, function(err, serverUrl) {
      if (err) {
        self.proxy._statsClient.increment('http.req.peer-management.status.5xx', { tenant: tenantId });
        response.statusCode = 500;
        response.end();
        return;
      }

      if (!serverUrl) {        
        self.proxy._statsClient.increment('http.req.peer-management.status.4xx', { tenant: tenantId });
        response.statusCode = 404;
        response.end();
        return;
      }

      self._proxyReq(request, response, parsed, serverUrl);
    });
  }
};

PeerManagement.prototype._locateConnectionIdTarget = function(tenantId, connectionId, cb) {
  var self = this;
  var servers = this.proxy.activeTargets(tenantId);

  var pending = [];
  async.detectLimit(servers, 5, function locateConnectionId(server, next) {
    var parsed = url.parse(server.url);
    parsed.pathname = '/peer-management';
    
    var req = http.get(url.format(parsed), function(res) {
      if (res.statusCode !== 200) {
        return next(false);
      }

      getBody(res, function(err, body) {
        if (err) {
          return next(false);
        }
        var json = null;
        try {
          json = JSON.parse(body.toString());
        } catch (err) {
          return next(false);
        }

        if (!Array.isArray(json.entities)) {
          return next(false);
        }
        
        var found = json.entities.some(function(entity) {
          return (entity.properties.connectionId === connectionId);
        });

        next(found);
      });
    });

    req.setTimeout(10000);
    req.on('error', function(err) {
      next(false);
    });
    pending.push(req);
  }, function(server) {
    pending.forEach(function(req) {
      req.abort();
    });
    return cb(null, (server) ? server.url : null);
  });
};

PeerManagement.prototype._proxyReq = function(request, response, parsed, serverUrl) {
  var self = this;
  var tenantId = getTenantId(request);
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
    self.proxy._statsClient.increment('http.req.peer-management.status.' + statusCode(response.statusCode), { tenant: tenantId });
    response.statusCode = targetResponse.statusCode;
    Object.keys(targetResponse.headers).forEach(function(header) {
      response.setHeader(header, targetResponse.headers[header]);
    });
    targetResponse.pipe(response);
  });

  target.on('error', function() {
    self.proxy._statsClient.increment('http.req.peer-management.status.5xx', { tenant: tenantId });
    response.statusCode = 500;
    response.end();
  });

  request.pipe(target);
};

PeerManagement.prototype.serveRoot = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);
  var startTime = new Date().getTime();

  var servers = this.proxy.activeTargets(tenantId).map(function(server) { 
    return url.parse(server.url);
  });
  
  var selfLink = parseUri(request);
  var parsed = url.parse(selfLink, true);
  var wsLink = url.format({ 
    host: parsed.host,
    slashes: true,
    protocol: (parsed.protocol === 'http:') ? 'ws' : 'wss',
    pathname: parsed.pathname,
  });

  var body = {
    class: ['peer-management'],
    actions: [],
    entities: [],
    links: [
      { rel: ['self'], href: selfLink },
      { rel: ['monitor'], href: wsLink }
    ]
  };

  if (servers.length === 0) {
    self.proxy._statsClient.increment('http.req.peer-management.status.2xx', { tenant: tenantId });
    sirenResponse(response, 200, body);
    return;
  }

  var pending = [];
  response.on('close', function() {
    pending.forEach(function(req) {
      req.abort();
    });
  });

  async.mapLimit(servers, 5, function(server, next) {
    var options = {
      method: request.method,
      headers: request.headers,
      hostname: server.hostname,
      port: server.port,
      path: parsed.path
    };

    var target = http.request(options);
    pending.push(target);
    target.on('response', function(targetResponse) {
      getBody(targetResponse, function(err, body) {
        if (err) {
          return next(null, { err: err });
        }
        var json = null;
        try {
          json = JSON.parse(body.toString());
        } catch (err) {
          return next(null, { err: err });
        }

        next(null, { res: targetResponse, json: json } );
      });
    });

    target.on('error', function(err) {
      next(null, { err: err });
    });

    target.end();
  }, function(err, results) {
    if (err) {
      self.proxy._statsClient.increment('http.req.peer-management.status.5xx', { tenant: tenantId });
      response.statusCode = 500;
      response.end();
      return;
    }
    
    // include only 200 status code responses
    var includes = results.filter(function(ret) { return !ret.err && ret.res.statusCode === 200 && ret.json; })

    includes.forEach(function(ret) {
      if (Array.isArray(ret.json.entities)) {
        var filtered = ret.json.entities.filter(function(entity) {
          return entity.properties.status === 'connected';
        });
        body.entities = body.entities.concat(filtered);
      }
    });
    
    self.proxy._statsClient.increment('http.req.peer-management.status.2xx', { tenant: tenantId });
    var duration = new Date().getTime() - startTime;
    self.proxy._statsClient.timing('http.req.peer-management', duration, { tenant: tenantId });

    sirenResponse(response, 200, body);
  });
};

PeerManagement.prototype.routeWs = function(request, socket) {
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


