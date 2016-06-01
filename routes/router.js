var url = require('url');
var ws = require('ws');
var logger = require('./logger');
var statsdLogger = require('./statsd_logger');
var getTenantId = require('./../utils/get_tenant_id');

var HttpRoot            = require('./http/root');
var HttpPeerManagement  = require('./http/peer_management');
var HttpProxy           = require('./http/proxy_to_target');
var HttpDeviceQuery     = require('./http/device_query');
var WsEvents            = require('./ws/events');
var WsMultiplexedEvents = require('./ws/multiplexed_events');
var WsPeering           = require('./ws/peering');

module.exports = function(proxy) {

  // Http Routes
  
  var httpRoot           = new HttpRoot(proxy);
  var httpPeerManagement = new HttpPeerManagement(proxy);
  var httpProxy          = new HttpProxy(proxy);
  var httpDeviceQuery    = new HttpDeviceQuery(proxy);

  proxy._server.on('request', function(request, response) {

    // ModuleName to be set for stats logging
    request._moduleName = 'na';
    request._tenantId = getTenantId(request);

    var reqStartTime = new Date().getTime();
    response.once('finish', function() {
      var duration = (new Date().getTime()-reqStartTime);
      logger(request, response, duration);
      statsdLogger(proxy._statsClient, request, response, request._moduleName, duration);
    });
    
    var parsed = url.parse(request.url, true);

    var routes = [
      { regex: /^\/$/, route: httpRoot }, // /
      { regex: /^\/\?.+/, route: httpDeviceQuery }, // /?...
      { regex: /^\/peer-management/, route: httpPeerManagement }, // /peer-management
      { regex: /^\/.+/, route: httpProxy } // *
    ];

    var found = routes.some(function(obj) {
      if (obj.regex.test(request.url)) {
        request._moduleName = obj.route.name;
        obj.route.handler(request, response, parsed);
        return true;
      }
    });

    // Handle 404
    if (!found) {
      response.statusCode = 404;
      response.end();
    }
  });

  // Websocket Routes
 
  var wsEvents            = new WsEvents(proxy);
  var wsMultiplexedEvents = new WsMultiplexedEvents(proxy);
  var wsPeering           = new WsPeering(proxy);
  
  proxy._server.on('upgrade', function(request, socket) {

    // Fake response for logging
    var fakeResponse = {
      statusCode: 101,
      getHeader: function() { return undefined; }
    };
    
    // Don't allow half open sockets on ws
    // Done in WS server to match functionality.
    // https://github.com/websockets/ws/blob/0669cae044d1902957acc7c89e1edfcf956f2de8/lib/WebSocketServer.js#L58
    socket.allowHalfOpen = false;
    
    // Handler peering requests
    if (/^\/peers\//.test(request.url)) {
      wsPeering.handler(request, socket);
      logger(request, fakeResponse);
      return;
    }

    // Setup WS Receiver to listen for close/ping messages
    var receiver = initWsParser(socket);

    var routes = [
      { regex: /^\/events$/, route: wsMultiplexedEvents }, // /events for multiplexed
      { regex: /^\/peer-management$/, route: wsEvents }, // /peer-management
      { regex: /^\/events\?/, route: wsEvents }, // /events?topic=
      { regex: /^\/servers\/(.+)$/, route: wsEvents }, // /servers/<hub>/events?topic=
    ];

    var found = routes.some(function(obj) {
      if (obj.regex.test(request.url)) {
        obj.route.handler(request, socket, receiver);
        logger(request, fakeResponse);
        return true;
      }
    });

    // Handle 404
    if (!found) {
      var responseLine = 'HTTP/1.1 404  Not Found\r\n\r\n\r\n';
      socket.end(responseLine);

      fakeResponse.statusCode = 404;
      logger(request, fakeResponse);
    }
  });
};

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

