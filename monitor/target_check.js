var http = require('http');
var url = require('url');

module.exports = function(opts, target, callback) {
  var parsed = url.parse(target.url);
  var options = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: '/'
  };

  var req = http.request(options, function(res) {
    clearTimeout(timer);
    res.on('data', function () {});
    if (res.statusCode !== 200) {
      return callback(false, new Error('Status code did not match 200'));
    }
    
    return callback(true);
  });

  req.on('error', function(err) {
    clearTimeout(timer);
    return callback(false, err);
  });

  // timeout timer
  var timer = setTimeout(function() {
    return callback(false, new Error('Timeout reached'));
    req.abort();
  }, opts.Timeout);

  req.end();
};
