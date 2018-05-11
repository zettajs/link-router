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

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var MockEtcd = module.exports = function() {
  this.keyValuePairs = {};
  this.watchers = {}; 
}

MockEtcd.prototype._findValue = function(key) {
  var paths = key.split('/');
  paths.shift();

  var root = this.keyValuePairs;
  var rootKey = '';

  var error = false;
  for(var i = 0; i < paths.length; i++) {
    if (!root.hasOwnProperty(paths[i])) {
      error = true;
      break;
    }

    rootKey += '/' + paths[i];
    root = root[paths[i]];
  }

  if (rootKey === '//') {
    rootKey = '/';
  }

  if (error) {
    return { error: true };
  } else {
    return { key: rootKey, obj: root };
  }
}

MockEtcd.prototype.get = function(key, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = null;
  }

  var v = this._findValue(key);

  if (v.error) {
    cb(null, new Error('Not Found'));
    return;
  }

  var rootKey = v.key;
  var root = v.obj;

  if ((options && options.recursive) || (typeof root === 'object' && Object.keys(root).length > 0)) {
    var results = {};
    var walk = function(currentKey, current, obj) {
      if (typeof obj === 'object') {
        var keys = Object.keys(obj);
        keys.forEach(function(key) {
          if (currentKey === '/') {
            currentKey = '';
          }

          current.key = currentKey;

          var node = { key: currentKey + '/' + key };
          if (typeof obj[key] === 'object') {
            node.dir = true;
          }

          if (Array.isArray(current.nodes)) {
            current.nodes.push(node);
          } else {
            current.nodes = [node];
          }

          walk(currentKey + '/' + key, current.nodes[current.nodes.length - 1], obj[key]);
        });
      } else {
        var node = { key: currentKey, value: obj };
        if (Array.isArray(current.nodes)) {
          current.nodes.push(node);
        } else {
          current.key = currentKey;
          current.value = obj;
        }
      }
    };

    var current = {};
    walk(rootKey, current, root);

    cb(null, { node: current });
  } else {
    if (typeof root === 'object') {
      root = JSON.stringify(root);
    }
    cb(null, { node: { key: rootKey, value: root } });
  }
};

MockEtcd.prototype.set = function(key, value, opts, cb) {
  if(typeof opts === 'function') {
    cb = opts;
  }

  var paths = key.split('/');
  paths.shift();

  var root = this.keyValuePairs;
  paths.forEach(function(path, i) {
    if (Object.keys(root).indexOf(path) === -1) {
      root[path] = {};
    }

    if (i === paths.length - 1) {
      root[path] = value;
    }

    root = root[path];
  });

  if (cb) {
    cb();
  }
};

MockEtcd.prototype.mkdir = function(key, cb) {
  var paths = key.split('/');
  paths.shift();

  var root = this.keyValuePairs;
  paths.forEach(function(path, i) {
    if (Object.keys(root).indexOf(path) === -1) {
      root[path] = {};
    }

    root = root[path];
  });

  if (cb) {
    cb();
  }
};

MockEtcd.prototype.del = function(key, cb) {
  var paths = key.split('/');
  paths.shift();

  var current = this.keyValuePairs;
  var error = false;

  for (var i = 0; i < paths.length; i++) {
    if (current.hasOwnProperty(paths[i])) {
      if (i === paths.length - 1) {
        delete current[paths[i]];
      } else {
        current = current[paths[i]];
      }
    } else {
      error = true;
      break;
    }
  }

  cb(error);
}

MockEtcd.prototype.watcher = function(key) {
  var watcherValues = this.watchers[key];

  if(!watcherValues) {
    this.watchers[key] = [];
    watcherValues = this.watchers[key];
  }

  var watcher = new MockWatcher();
  watcherValues.push(watcher);
  return watcher;
};

MockEtcd.prototype.compareAndSwap = function(key, newRecord, oldRecord, cb) {
  var self = this;
  // make compare and swap async 
  setTimeout(function() {
    self.get(key, function(err, results) {
      var item = results.node.value;
      if (item === oldRecord) {
        self.set(key, newRecord, cb);
      }
    });
  }, 0);
};

//Trigger a watcher event for a key.
MockEtcd.prototype._trigger = function(key, value) {
  var self = this;
  var watcherKeys = Object.keys(this.watchers).filter(function(k) {
    return key.indexOf(k) === 0;
  });

  watcherKeys.forEach(function(k) {
    self.watchers[k].forEach(function(watcher) {
      watcher.emit('change', { action: 'set', node: { key: key, value: value }});  
    });
  });
}

//Trigger a watcher event for a key.
MockEtcd.prototype._triggerDel = function(key) {
  var self = this;
  var watcherKeys = Object.keys(this.watchers).filter(function(k) {
    return key.indexOf(k) === 0;
  });

  watcherKeys.forEach(function(k) {
    self.watchers[k].forEach(function(watcher) {
      watcher.emit('change', { action: 'delete', node: { key: key }});  
    });
  });
}
var MockWatcher = function() {
  EventEmitter.call(this);  
};
util.inherits(MockWatcher, EventEmitter);
