var util = require('util');
var levelup = require('levelup');
var memdown = require('memdown');
var PeerRegistry = require('zetta').PeerRegistry;

var MemPeerRegistry = module.exports = function() {
  var db = levelup({ db: memdown });
  PeerRegistry.call(this, { db: db, collection: 'peers' });  
}
util.inherits(MemPeerRegistry, PeerRegistry);
