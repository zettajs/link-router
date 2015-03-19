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

  

  this._watcher = this._client.watcher(this._etcdDirectory);
  this._watcher.on('change', function(results) {
    var versionObject = JSON.parse(results.node.value);
    self.emit('change', versionObject); 
  });
}
util.inherits(VersionClient, EventEmitter);

VersionClient.prototype.get = function(cb) {
  this._client.get(this._etcdDirectory, function(err, results) {
    if(err) {
      cb(err);
      return;
    }
    
    var versionObject = JSON.parse(results.node.value);
    
    cb(null, versionObject);  
  }); 
};


