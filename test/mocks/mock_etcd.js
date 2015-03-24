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

  if (options && options.recursive) {
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

MockEtcd.prototype.del = function(key, cb) {
  //var obj = this.keyValuePairs[key];

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
  this.get(key, function(err, results) {
    var item = results.node.value;
    if (item === oldRecord) {
      self.set(key, newRecord, cb);
    }
  });
};

//Trigger a watcher event for a key.
MockEtcd.prototype._trigger = function(key, value) {
  var watcherValues = this.watchers[key];
  if(!watcherValues) {
    this.watchers[key] = [];
    watcherValues = this.watchers[key];
  }
  
  watcherValues.forEach(function(watcher) {
    watcher.emit('change', { node: { value: value}});  
  });
}

var MockWatcher = function() {
  EventEmitter.call(this);  
};
util.inherits(MockWatcher, EventEmitter);
