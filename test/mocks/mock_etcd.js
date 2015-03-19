var EventEmitter = require('events').EventEmitter;
var util = require('util');

var MockEtcd = module.exports = function() {
  this.keyValuePairs = {};
  this.watchers = {}; 
}

MockEtcd.prototype.get = function(key, cb) {
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
    cb(new Error("No Key Found.")); 
  }  
};

MockEtcd.prototype.set = function(key, value, opts, cb) {
  if(typeof opts === 'function') {
    cb = opts;
  }

  this.keyValuePairs[key] = { value: value };

  if(cb) {
    cb();  
  }
};
MockEtcd.prototype.del = function(key, cb) {
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

//Trigger a watcher event for a key.
MockEtcd.prototype._trigger = function(key, value) {
  var watcherValues = this.watchers[key];
  if(!watcherValues) {
    this.watchers[key] = [];
    watcherValues = this.watchers[key];
  }
  
  watcherValues.forEach(function(watcher) {
    watcher.emit('change', value);  
  });
}

var MockWatcher = function() {
  EventEmitter.call(this);  
};
util.inherits(MockWatcher, EventEmitter);



