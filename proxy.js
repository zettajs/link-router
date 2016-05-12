var http = require('http');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var RouterCache = require('./router_cache');
var router = require('./routes/router');
var TargetAllocation = require('./target_allocation');

var Proxy = module.exports = function(serviceRegistryClient,
                                      routerClient,
                                      versionClient,
                                      statsClient,
                                      targetMonitor) {

  EventEmitter.call(this);

  this._serviceRegistryClient = serviceRegistryClient;
  this._routerClient = routerClient;
  this._versionClient = versionClient;
  this._statsClient = statsClient;
  this._currentVersion = null;
  this._routerCache = new RouterCache();
  this._servers = {};
  this._targetMonitor = targetMonitor;
  this._targetAllocation = new TargetAllocation(this);

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

  self._routerClient.on('change', function(results) {
    // Clear cache b/c we have full list of router from results
    self._routerCache.reset();

    results.forEach(function(obj) {
      self._routerCache.set(obj.tenantId, obj.name, obj.url);
    });
    
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
