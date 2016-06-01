var moment = require('moment');

// Modified from argo-clf
// https://github.com/mdobson/argo-clf/blob/master/index.js
module.exports = function(req, res, duration) {
  var UNKNOWN = '-';
  var ip = req.connection.remoteAddress;
  var date = '[' + moment(Date.now()).format('D/MMM/YYYY:HH:mm:ss ZZ') + ']';
  var method = req.method;
  var url = req.url;
  var requestSummary = '"' + method + ' ' + url + '"';
  var status = res.statusCode;
  var length = 0;

  if (status !== 101) { 
    var contentLength = res.getHeader('Content-Length');
    if (contentLength === '0' || contentLength === undefined) {
      length = 0;
    } else {
      length = contentLength;
    }
  } else {
    length = 'UPGRADED';
  }


  if (!process.env.SILENT) {
    var log = [ ip, UNKNOWN, UNKNOWN, date, requestSummary, status, length ];
    console.log(log.join('\t'));
  }
}
