var crypto = require('crypto');

module.exports = function(request, socket) {
  var key = request.headers['sec-websocket-key'];
  var shasum = crypto.createHash('sha1');
  shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  var serverKey = shasum.digest('base64');

  var responseLine = 'HTTP/1.1 101 Switching Protocols';
  var headers = ['Upgrade: websocket', 'Connection: Upgrade',
                 'Sec-WebSocket-Accept: ' + serverKey]

  socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
};
