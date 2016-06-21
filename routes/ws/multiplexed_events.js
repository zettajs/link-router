var url = require('url');
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

  var streamEnabled = false;
  var subscriptions = []; // list of subscriptions to subscribed to initially
  if (/^\/events$/.test(request.url)) {
    // /events for multiplexed
    streamEnabled = true;
  } else if (/^\/peer-management$/.test(request.url)) {
    // /peer-management
    subscriptions.push('_peer/*');
  } else if (/^\/events\?/.test(request.url)) {
    // /events?topic=
  } else if (/^\/servers\/(.+)$/.test(request.url)) {
    // /servers/<targetName>/events?topic=...
    var parsed = url.parse(request.url, true);
    var targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);

    if (!parsed.query.topic) {
      // return 400
    }

    subscriptions.push(targetName + '/' + parsed.query.topic);
  }

  var client = new EventSocket(request, socket, wsReceiver, { streamEnabled: streamEnabled });
  this._eventBroker.client(client);
  
  var err = null;
  subscriptions.every(function(topic) {
    var ret = client._subscribeToTopic(topic);
    if (ret !== true) {
      err = ret;
      return false;
    } else {
      return true;
    }
  });

  if (err) {
    var responseLine = 'HTTP/1.1 400  ' + err.message + '\r\n\r\n\r\n';
    socket.end(responseLine);
    return;
  }

  client.confirmWs();
};

