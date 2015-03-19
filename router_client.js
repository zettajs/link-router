var Etcd = require('node-etcd');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var RouterClient = module.exports = function(options) {
  EventEmitter.call(this);
  this._etcDirectory = '/router/zetta';

  if(!options.client) {
    this._client = new Etcd(options.host);
  } else {
    this._client = options.client;
  }  
  
  this._ttl = 120; // seconds
  this._watcher = this._client.watcher(this._etcDirectory, null, {recursive: true});
  this._watcher.on('change', function() {
    self.findAll(function(err, results) {
      if(err) {
        console.log(err);
        return;
      }
      
      self.emit('change', results);  
    });
  });
};
util.inherits(RouterClient, EventEmitter);

RouterClient.prototype.findAll = function(cb) {
  this._client.get(this._etcDirectory, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    if (results.node.nodes && results.node.nodes.length > 0) {
      cb(null, results.node.nodes.map(function(item) {
        item = JSON.parse(item.value);
        return {
          name: item.name,
          url: item.url,
          created: item.created
        };
      }));
    } else {
      cb();
    }
  });
};

RouterClient.prototype.get = function(targetName, cb) {
  this._client.get(this._etcDirectory + '/' + targetName, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    if (results.node) {
      var route = JSON.parse(results.node.value);
      cb(null, route.url);
    } else {
      cb();
    }
  });
};

RouterClient.prototype.add = function(targetName, serverUrl, cb) {
  var params = { name: targetName, url: serverUrl, created: new Date() };
  this._client.set(this._etcDirectory + '/' + targetName, JSON.stringify(params), { ttl: this._ttl }, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    cb();
  });
};

RouterClient.prototype.remove = function(targetName, cb) {
  this._client.del(this._etcDirectory + '/' + targetName, function(err, results) {
    if (err) {
      cb(err);
      return;
    }

    cb();
  });
};
