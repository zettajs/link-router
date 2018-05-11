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

var Etcd = require('node-etcd');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var CloudDeviceDir = 'cloud-device';

var RouterClient = module.exports = function(options) {
  EventEmitter.call(this);
  var self = this;
  this._etcDirectory = '/router/zetta';

  if(!options.client) {
    this._client = new Etcd(options.host);
  } else {
    this._client = options.client;
  }  
  
  this._ttl = 120; // seconds
  this._watcher = this._client.watcher(this._etcDirectory, null, { recursive: true, consistent: true });
  this._watcher.on('change', function() {
    self.findAll(function(err, results) {
      if(err) {
        console.error(err);
        return;
      }
      
      self.emit('change', results);  
    });
  });
};
util.inherits(RouterClient, EventEmitter);

RouterClient.prototype.findAll = function(tenantId, isCloudDevice, cb) {
  this._findAll(tenantId, isCloudDevice, cb, true);
};
RouterClient.prototype.findAllNonRecursive = function(tenantId, isCloudDevice, cb) {
  this._findAll(tenantId, isCloudDevice, cb, false);  
};

RouterClient.prototype._findAll = function(tenantId, isCloudDevice, cb, recursive) {
  if (typeof tenantId === 'function') {
    cb = tenantId;
    tenantId = null;
  }

  if (typeof isCloudDevice === 'function') {
    cb = isCloudDevice;
    isCloudDevice = false;
  }

  var dir = tenantId ? this._etcDirectory + '/' + tenantId : this._etcDirectory;
  if (isCloudDevice) {
    dir = dir + '/' + CloudDeviceDir;
  }
  
  this._client.get(dir, { recursive: recursive, consistent: true }, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    if (results.node && results.node.nodes && results.node.nodes.length > 0) {
      var nodes = results.node.nodes
        .filter(function(item) { return !item.dir; })
        .map(function(item) {
          try {
            item = JSON.parse(item.value);
            return {
              tenantId: item.tenantId,
              name: item.name,
              url: item.url,
              created: item.created
            };
          } catch(err) {
            return null;
          }
        })
        .filter(function(item) {
          return item !== null;
        });      

      results.node.nodes
          .filter(function(item) { return item.dir })
          .forEach(function(item) {
            if (item.nodes) {
              item.nodes
                .filter(function(item) { return !item.dir; })
                .forEach(function(item) {
                  try {
                    item = JSON.parse(item.value);
                    nodes.push({
                      tenantId: item.tenantId,
                      name: item.name,
                      url: item.url,
                      created: item.created
                    });
                  } catch(err) {
                    
                  }
                });
            }
          });
      cb(null, nodes);
    } else {
      cb(null, []);
    }
  });
};

RouterClient.prototype.get = function(tenantId, targetName, isCloudDevice, cb) {
  if (typeof targetName === 'function') {
    cb = targetName;
    targetName = tenantId;
    tenantId = null;
  }


  if (typeof isCloudDevice === 'function') {
    cb = isCloudDevice;
    isCloudDevice = false;
  }

  var dir = tenantId ? this._etcDirectory + '/' + tenantId : this._etcDirectory;
  if (isCloudDevice) {
    dir = dir + '/' + CloudDeviceDir;
  }

  this._client.get(dir + '/' + targetName, { consistent: true }, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    if (results.node) {
      var route = null;
      try {
        route = JSON.parse(results.node.value);
      } catch(err) {
        return cb(err);
      }
      cb(null, route.url);
    } else {
      cb();
    }
  });
};

RouterClient.prototype.add = function(tenantId, targetName, serverUrl, cb) {
  if (typeof serverUrl === 'function') {
    cb = serverUrl;
    serverUrl = targetName;
    targetName = tenantId;
    tenantId = null;
  }

  var dir = tenantId ? this._etcDirectory + '/' + tenantId : this._etcDirectory;
  var params = { name: targetName, tenantId: tenantId, url: serverUrl, created: new Date() };
  this._client.set(dir + '/' + targetName, JSON.stringify(params), { ttl: this._ttl }, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    cb();
  });
};

RouterClient.prototype.remove = function(tenantId, targetName, cb) {
  if (typeof targetName === 'function') {
    cb = targetName;
    targetName = tenantId;
    tenantId = null;
  }

  var dir = tenantId ? this._etcDirectory + '/' + tenantId : this._etcDirectory;
  this._client.del(dir + '/' + targetName, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    cb();
  });
};
