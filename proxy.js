
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

var url = require('url');
var http = require('http');
var util = require('util');
var spdy = require('spdy');
var async = require('async');
var jwt = require('jsonwebtoken');
var EventEmitter = require('events').EventEmitter;
var RouterCache = require('./router_cache');
var router = require('./routes/router');
var getBody = require('./utils/get_body');

var Proxy = module.exports = function(serviceRegistryClient,
                                      routerClient,
                                      versionClient,
                                      statsClient,
                                      tenantMgmtApi,
                                      jwtPlaintextKeys) {

  EventEmitter.call(this);

  this._serviceRegistryClient = serviceRegistryClient;
  this._routerClient = routerClient;
  this._versionClient = versionClient;
  this._statsClient = statsClient;
  this._currentVersion = null;
  this._routerCache = new RouterCache();
  this._servers = {};
  this._tenantMgmtApi = tenantMgmtApi;
  this.jwtPlaintextKeys = jwtPlaintextKeys;

  this._spdyCache = { }; // <target>: spdyAgent 

  this.peerActivityTimeout = 60000;

  this._server = http.createServer();

  this._setup();
};
util.inherits(Proxy, EventEmitter);

Proxy.prototype._setup = function() {
  var self = this;

  // Setup http/ws routes
  router(this);

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

  self._routerClient.on('update', function(tenantId, targetName, obj) {
    self._routerCache.set(obj.tenantId, obj.name, obj.url);
    self.emit('router-update', self._routerCache);
  });

  self._routerClient.on('remove', function(tenantId, targetName) {
    self._routerCache.del(tenantId, targetName);
    self.emit('router-update', self._routerCache);
  });

  self._serviceRegistryClient.on('change', function(results) {
    self._processServerList(results);
    self.emit('services-update');
  });

  this._loadServers(function() {
    self.emit('services-update');
  });

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

Proxy.prototype.listen = function() {
  this._server.listen.apply(this._server, Array.prototype.slice.call(arguments));
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
    return (server.version === self._currentVersion || activeServers.indexOf(server.url) >= 0);
  });
};


// Return all targets for a tenantId with the current version
Proxy.prototype.targets = function(tenantId) {
  var self = this;

  if (!this._servers.hasOwnProperty(tenantId)) {
    return [];
  }

  return this._servers[tenantId].filter(function(server) {
    return server.version === self._currentVersion;
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

Proxy.prototype.proxyToTarget = function(targetUrl, request, response, options) {
  var parsed = url.parse(targetUrl);

  if (options === undefined) {
    options = {};
  }

  var httpOptions = {
    hostname: parsed.hostname,
    port: parsed.port,
    agent: this.getSpdyAgent(targetUrl),
    
    method: options.method || request.method,
    headers: options.headers || request.headers,
    path: options.path || request.url
  };

  // If no forwarded protocol then we must set http because zetta will
  // set the ws urls to spdy.
  if (!httpOptions.headers.hasOwnProperty('x-forwarded-proto')) {
    httpOptions.headers['x-forwarded-proto'] = 'http';
  }

  // If needed add jwt to headers
  this.addTokenToReqOptions(httpOptions, targetUrl);
  
  var target = http.request(httpOptions);

  if (options.timeout) {
    target.setTimeout(options.timeout, function() {
      target.abort();
      response.statusCode = 500;
      response.end();
    });
  }

  // close target req if client is closed before target finishes
  response.on('close', function() {
    target.abort();
  });

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

// Preform same request on all active targets for a tenant, get body from each target and
// return to callback.
Proxy.prototype.scatterGatherActive = function(tenantId, request, options, cb) {
  var self = this;
  
  // If tenantId is string get active servers, allow servers to be overiden with array of urls 
  if (Array.isArray(tenantId)) {
    var servers = tenantId;
  } else {
    var servers = this.activeTargets(tenantId).map(function(v) { return v.url; });
  }

  servers = servers.map(url.parse);

  if (typeof options === 'function') {
    cb = options;
    options = {};
  }

  var pending = [];
  async.mapLimit(servers, (options.asyncLimit || 5), function(parsed, next) {
    var httpOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      agent: self.getSpdyAgent(url.format(parsed)),
      
      method: options.method || request.method,
      headers: options.headers || request.headers,
      path: options.path || request.url
    };

    // If needed add jwt to headers
    self.addTokenToReqOptions(httpOptions, url.format(parsed));

    // When specifing array of urls optionally use path on each array entry not request or option path
    if (options.useServersPath) {
      httpOptions.path = parsed.path;
    }

    var target = http.request(httpOptions);
    pending.push(target);

    if (options.timeout) {
      target.setTimeout(options.timeout, function() {
        target.abort();
        next(null, { err: new Error('Request to target timed out.') });
      });
    }

    target.on('response', function(targetResponse) {
      getBody(targetResponse, function(err, body) {
        if (err) {
          return next(null, { server: url.format(parsed), err: err });
        }
        
        var json = null;
        try {
          json = JSON.parse(body.toString());
        } catch (err) {
          return next(null, { server: url.format(parsed), err: err });
        }

        next(null, { server: url.format(parsed), res: targetResponse, json: json } );
      });
    });

    target.on('error', function(err) {
      next(null, { server: url.format(parsed), err: err });
    });

    target.end();    
  }, function(err, results) {
    if (err) {
      pending.forEach(function(req) {
        req.abort();
      });
      return cb(err);
    }
    return cb(null, results);
  });
};

Proxy.prototype.addTokenToReqOptions = function(options, targetUrl) {
  if (!this.jwtPlaintextKeys) {
    return;
  }
  
  var token = { location: targetUrl };
  var cipher = jwt.sign(token, this.jwtPlaintextKeys.internal, { expiresIn: 60 });

  if (!options.headers) {
    options.headers = {};
  }
  
  options.headers['Authorization'] = cipher;
};

Proxy.prototype.getSpdyAgent = function(targetUrl) {
  var self = this;
  var parsed = url.parse(targetUrl);
  var hash = parsed.host; // hash = host.com:8080
  
  if (this._spdyCache[hash]) {
    return this._spdyCache[hash];
  }

  this._spdyCache[hash] = spdy.createAgent({
    host: parsed.hostname,
    port: parsed.port,

    // Optional SPDY options
    spdy: {
      plain: true,
      ssl: false,
      protocols: ['spdy/3.1']
    }
  }).once('error', function (err) {
    delete self._spdyCache[hash];
  });
  
  var em = this._spdyCache[hash]._spdyState.connection.socket;

  em.once('close', function() {
    delete self._spdyCache[hash];
  });
  
  em.once('error', function() {
    delete self._spdyCache[hash];
  });


  return this._spdyCache[hash];
};

