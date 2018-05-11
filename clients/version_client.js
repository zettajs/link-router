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

var VersionClient = module.exports = function(options) {
  EventEmitter.call(this);
  var self = this;
  this._etcdDirectory = '/zetta/version';
  
  if(!options.client) {
    this._client = new Etcd(options.host);
  } else {
    this._client = options.client;
  }

  this._watcher = this._client.watcher(this._etcdDirectory, null, { consistent: true });
  this._watcher.on('change', function(results) {
    var versionObject = null;
    try {
      versionObject = JSON.parse(results.node.value);      
    } catch(err) {
      return;
    }
    self.emit('change', versionObject); 
  });
}
util.inherits(VersionClient, EventEmitter);

VersionClient.prototype.get = function(cb) {
  this._client.get(this._etcdDirectory, { consistent: true }, function(err, results) {
    if(err) {
      cb(err);
      return;
    }
    
    var versionObject = null;
    try {
      versionObject = JSON.parse(results.node.value);
    } catch(err) {
      return cb(err);
    }
    cb(null, versionObject); 
  }); 
};


