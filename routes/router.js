var url = require('url');
var ws = require('ws');

function initWsParser(socket) {
  var receiver = new ws.Receiver();
  socket.on('data', function(buf) {
    receiver.add(buf);
  });

  // request from client to close websocket
  receiver.onclose = function() {
    socket.end();
  };

  // handle ping requests
  receiver.onping = function(data, flags) {
    var sender = new ws.Sender(socket);
    sender.pong(data, { binary: flags.binary === true }, true);
  };

  socket.once('close', function() {
    receiver.cleanup();
  });

  return receiver;
}

module.exports = function(proxy) {

  // Http Routes
  
  var httpRoot           = new (require('./http/root'))(proxy);
  var httpPeerManagement = new (require('./http/peer_management'))(proxy);
  var httpProxy          = new (require('./http/proxy_to_target'))(proxy);
  var httpDeviceQuery    = new (require('./http/device_query'))(proxy);
  
  proxy._server.on('request', function(request, response) {
    var parsed = url.parse(request.url, true);
    
    if (parsed.pathname === '/') {
      if (parsed.query.ql) {
        // Device query or cross server query
        httpDeviceQuery.handler(request, response, parsed);
      } else {
        // Server root response
        httpRoot.handler(request, response, parsed);
      }
    } else if (/^\/peer-management/.test(request.url)) {
      httpPeerManagement.handler(request, response, parsed);
    } else {
      // Proxy to zetta target
      httpProxy.handler(request, response, parsed);
    }
  });

  // Websocket Routes
 
  var wsEvents            = new (require('./ws/events'))(proxy);
  var wsMultiplexedEvents = new (require('./ws/multiplexed_events'))(proxy);
  var wsPeerManagement    = new (require('./ws/peer_management'))(proxy);
  var wsDeviceQuery       = new (require('./ws/device_query'))(proxy);
  var wsPeering           = new (require('./ws/peering'))(proxy);
  
  proxy._server.on('upgrade', function(request, socket) {
    // Don't allow half open sockets on ws
    // Done in WS server to match functionality.
    // https://github.com/websockets/ws/blob/0669cae044d1902957acc7c89e1edfcf956f2de8/lib/WebSocketServer.js#L58
    socket.allowHalfOpen = false;

    // Handler peering requests
    if (/^\/peers\//.test(request.url)) {
      wsPeering.handler(request, socket);
      return;
    }

    // Setup WS Receiver to listen for close/ping messages
    var receiver = initWsParser(socket);

    if (request.url === '/events') {
      // Multiplexed ws
      wsMultiplexedEvents.handler(request, socket, receiver);
    } else if (/^\/events\?/.test(request.url)) {
      // Reactive device query
      wsDeviceQuery.handler(request, socket, receiver);
    } else if (/^\/peer-management/.test(request.url)) {
      // Peer management ws
      wsPeerManagement.handler(request, socket, receiver);
    } else {
      // Single Topic Event ws
      wsEvents.handler(request, socket, receiver);
    }
  });
};
