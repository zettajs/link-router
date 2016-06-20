var EventBroker = require('./event_broker');
var EventSocket = require('./event_socket');

var Handler = module.exports = function(proxy) {
  this.proxy = proxy;
  this._cache = {};
  this._queryCache = {};
  this._eventBroker = new EventBroker(proxy);
};

Handler.prototype.handler = function(request, socket, wsReceiver) {
  var self = this;
  var socket = new EventSocket(request, socket, wsReceiver, { streamEnabled: true });
  this._eventBroker.client(socket);
};

