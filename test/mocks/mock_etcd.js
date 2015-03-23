var EventEmitter = require('events').EventEmitter;
var util = require('util');

var MockEtcd = module.exports = function() {
  this.keyValuePairs = {};
  this.watchers = {}; 
}

MockEtcd.prototype.get = function(key, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = null;
  }

  var object = this.keyValuePairs[key];
  if(object) {
    var result = null;
    if(Array.isArray(object)) {
      result = { node: { nodes: object }};
    } else {
      result = { node: object };
    }
    cb(null, result); 
  } else {
    cb(null, []); 
  }  
};

MockEtcd.prototype.set = function(key, value, opts, cb) {
  if(typeof opts === 'function') {
    cb = opts;
  }

  var pathArray = key.split('/');
  pathArray.pop();
  var collectionKey = pathArray.join('/');
  
  if(this.keyValuePairs[collectionKey]) {
    this.keyValuePairs[collectionKey].push({ value: value });
  } else {
    this.keyValuePairs[collectionKey] = [{value: value}];
  }

  this.keyValuePairs[key] = { value: value };

  if(cb) {
    cb();  
  }
};
MockEtcd.prototype.del = function(key, cb) {
  var obj = this.keyValuePairs[key];
  
  var pathArray = key.split('/');
  pathArray.pop();
  var collectionKey = pathArray.join('/');
  
  var filteredCollection = this.keyValuePairs[collectionKey].filter(function(item) {
    return item.value !== obj.value;  
  });

  this.keyValuePairs[collectionKey] = filteredCollection;

  delete this.keyValuePairs[key];

  if(cb) {
    cb();  
  }  
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
