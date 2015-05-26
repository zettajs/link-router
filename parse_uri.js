var path = require('path');

module.exports = function(request) {
  var xfp = request.headers['x-forwarded-proto'];
  var xfh = request.headers['x-forwarded-host'];
  var protocol;

  if (xfp && xfp.length) {
    protocol = xfp.replace(/\s*/, '').split(',')[0];
  } else {
    protocol = request.connection.encrypted ? 'https' : 'http';
  }

  var host = xfh || request.headers['host'];

  if (!host) {
    var address = request.connection.address();
    host = address.address;
    if (address.port) {
      if (!(protocol === 'https' && address.port === 443) && 
          !(protocol === 'http' && address.port === 80)) {
        host += ':' + address.port
      }
    }
  }

  return protocol + '://' + path.join(host, request.url);
};
