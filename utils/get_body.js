
module.exports = function(res, callback) {
  if (!res.readable) {
    return callback();
  }

  var body = null;
  var buf = [];
  var len = 0;

  res.on('readable', function() {
    var chunk;

    while ((chunk = res.read()) != null) {
      buf.push(chunk);
      len += chunk.length;
    }

    if (!buf.length) {
      return;
    }

    if (buf.length && Buffer.isBuffer(buf[0])) {
      body = new Buffer(len);
      var i = 0;
      buf.forEach(function(chunk) {
        chunk.copy(body, i, 0, chunk.length);
        i += chunk.length;
      });
    } else if (buf.length) {
      body = buf.join('');
    }
  });

  var error = null;
  res.on('error', function(err) {
    error = err;
  });

  res.on('end', function() {
    body = body;
    callback(error, body);
  });

  if (typeof res.read === 'function') {
    res.read(0);
  }
};
