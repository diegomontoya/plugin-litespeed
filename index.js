var _async = require('async');
var _fs = require('fs');
var _os = require('os');
var _param = require('./param.json');
var _path = require('path');
var _tools = require('graphdat-plugin-tools');

var WHITE_LIST = ['MAXCONN:','BPS_IN:','REQ_RATE','EXTAPP'];

var _pollInterval; // the interval to poll the metrics
var _reportPath; // the directory with the litespeed files
var _reports = []; // litespeed writes a file per core depnding on your licence
var _source; // the source of the metrics
var _vhosts = {}; // the virtual hosts to monitor, if none, show all with limit set by _auto_vhosts_limit

var _auto_vhosts_limit = _param.auto_vhosts_limit || 20; //if vhosts are not set and in auto mode, how many should we show?
var _auto_vhosts_mode = true; //are we in auto vhosts mode

// ==========
// VALIDATION
// ==========

// set the reportPath if we do not have one
_reportPath = _param.reportPath || '/tmp/lshttpd';

if (!_fs.existsSync(_path.join(_reportPath, '.rtreport')))
{
    console.error('The report path "%s" was not found', _reportPath);
    process.exit(-1);
}

// set the pollTime if we do not have one
_pollInterval = (_param.pollInterval || 1000);

// set the source if we do not have one
//default to to full host name or partial if partialHostname is set to true
if(true || _param.partialHostname)
    _source = (_param.source || _os.hostname()).trim().split('.')[0]; // get the metric source
else
    _source = (_param.source || _os.hostname()).trim(); // get the metric source


// =============
// CONFIGURATION
// =============

// Parse the directory to get all of the files, we do not have permissions to actually list the files
if (_fs.existsSync(_path.join(_reportPath, '.rtreport')))
    _reports.push(_path.join(_reportPath, '.rtreport'));

// now check if the individual CPU files exist
for(var i=1; i<_os.cpus().length; i++)
    if (_fs.existsSync(_path.join(_reportPath, '.rtreport.' + i)))
        _reports.push(_path.join(_reportPath, '.rtreport.' + i));

// if we have a set of vhosts, add them in
if (_param.vhosts_filter)
{
    _param.vhosts_filter.forEach(function(vh)
    {
        if (!vh)
            return;

        var value = vh.split('|');
        var host = value[0];
        var alias = value[1];
        if (_vhosts[host])
        {
            console.error('The virtual host %s is defined twice.  Each host should be unique', host);
            process.exit(-1);
        }
        _vhosts[host] = (alias || host).trim(); // if there is an alias use it

        if(auto_vhosts_mode)
            _auto_vhosts_mode = false;
    });
}

//global vhost
_vhosts[''] = 'Global';

// ================
// HELPER FUNCTIONS
// ================

// get the natural difference between a and b
function diff(a, b)
{
    if (a == null || b == null || isNaN(a) || isNaN(b))
        return 0;
    else
        return Math.max(a - b, 0);
}

// convert to a float if possible
function toNumeric(x)
{
    if (x == null)
        return 0;

    var y = parseFloat(x, 10);
    return (isNaN(y) ? 0 : y);
}

// parse string for key:value pairs
function parseKVPs(data)
{
    var result = {};
    while(true)
    {
        var kvp = data.match(/(\w+):\s*([0-9\.]+)?/);
        if (!kvp)
            break;

        result[kvp[1].toUpperCase()] = toNumeric(kvp[2]);
        data = data.replace(kvp[0], '');
    }
    return result;
}

// ===============
// LET GET STARTED
// ===============

function parseReport(reportPath, cb)
{
    /*
        --- sample litespeed enterprise config ---
        VERSION: LiteSpeed Web Server/Enterprise/4.2.4
        UPTIME: 03:24:02
        BPS_IN: 0, BPS_OUT: 0, SSL_BPS_IN: 0, SSL_BPS_OUT: 0
        MAXCONN: 2000, MAXSSL_CONN: 200, PLAINCONN: 0, AVAILCONN: 2000, IDLECONN: 0, SSLCONN: 0, AVAILSSL: 200
        REQ_RATE []: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 30, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 03
        REQ_RATE [_AdminVHost]: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 26, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 0
        REQ_RATE [Example]: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 4, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 0
        EXTAPP [Proxy] [] [BACKEND]: CMAXCONN: 2000, EMAXCONN: 2000, POOL_SIZE: 18, INUSE_CONN: 4, IDLE_CONN: 14, WAITQUE_DEPTH: 0,
        BLOCKED_IP:
        EOF
        --------------------------------
     */

    try
    {
        // read the report
        _fs.readFile(reportPath, {encoding: 'utf8'}, function(err, lines)
        {
            if (err)
                return cb(err);
            if (!lines)
                return cb(null, {});

            // we save 'vhosts' separately so we can sum them up across each report
            var data = { vhosts:{}, extapps:{} };

            lines.toString().split('\n').forEach(function(line)
            {
                if (!line)
                    return;

                // only process the lines with prefix we want
                var key = line.split(' ')[0];
                if (!key || WHITE_LIST.indexOf(key) == -1)
                    return;

                // For most data we just do a simple KVP addition
                var destination = data;
                var toParse = line;

                // REQ_RATE is the `key` if we are dealing with a VHOST,
                // which is checked against the filter list
                if (key.indexOf('REQ_RATE') === 0)
                {
                    // do we have a vhost
                    var match = line.match(/REQ_RATE \[(.*)\]: (.*)/);
                    if (!match)
                        return;

                    var vhost = match[1].trim();
                    if(vhost.length)
                       _vhosts[vhost] = vhost; // if there is an alias use it

                    data.vhosts[vhost] = {};

                    destination = data.vhosts[vhost];
                    toParse = match[2];
                }

                //// EX_APP is the `key` if we are dealing with a VHOST,
                else if (key.indexOf('EXTAPP') === 0)
                {
                    // do we have a vhost
                    var match = line.match(/EXTAPP \[(.*)\] \[(.*)\] \[(.*)\]: (.*)/);

                    //console.log(match);

                    if (!match) {
                        return;
                    }

                    var ext_vhost = match[2].trim(); //ext_app vhost name
                    var ext_type = match[1].trim(); //exta_app type: proxy,lsapi,fcgi,etc
                    var ext_name = match[3].trim(); //ext_app name

                    if(!_vhosts[ext_vhost]) {
                        console.error('EXT_APP: The virtual host %s should already be defined', ext_vhost);
                        process.exit(-1);
                    }

                    if (!data.extapps[ext_vhost])
                        data.extapps[ext_vhost] = {};

                    destination = data.extapps[ext_vhost][ext_name] = {};

                    destination['TYPE'] = ext_type.toUpperCase(); //exta_app type: proxy,lsapi,fcgi,etc
                    destination['NAME'] = ext_name; //ext_app name

                    toParse = match[4];
                }

                // parse the KVPs and add them to the tally
                var kvps = parseKVPs(toParse);
                for(var k in kvps)
                {
                    if (k in destination)
                        destination[k] += kvps[k];
                    else
                        destination[k] = kvps[k];
                }
            });

            return cb(null, data);
        });
    }
    catch(e)
    {
        return cb(e);
    }
}

// call the socket object to get the statistics
function getReportData(cb)
{
    var funcs = _reports.map(function(reportPath) { return function(innerCb) { parseReport(reportPath, innerCb); }; });
    _async.parallel(
        funcs,
        function(err, results)
        {
            if (err)
                return cb(err);
            if (!results || results.length === 0)
                return cb(null, {});

            // pick a result to use as the base to add all results too
            var data = results[0];

            // go through every result (off by 1 as 0 is our base)
            for(var i=1; i<results.length; i++)
            {
                if (!results[i] || Object.keys(results[i]).length === 0)
                    continue;

                // sum up all of the keys
                var result = results[i];
                Object.keys(results[i]).forEach(function(key)
                {
                    // we treat vhosts and extapps differently, will do them in the next pass
                    if (key === 'vhosts' || key == "extapps")
                        return;

                    //server level stats
                    if (!(key in data))
                        data[key] = result[key];
                    else
                        data[key] += result[key];
                });

                /*
                NOTE: if litespeed is operating on multiple cores, the report can be DIFFERENT in terms
                the number of vhosts and extapps reported.
                 */

                // sum up all of the vhosts
                for(var host in result.vhosts)
                {
                    if (!data.vhosts[host])
                        data.vhosts[host] = {};

                    for(var k in result.vhosts[host])
                    {
                        if (!(k in data.vhosts[host]))
                            data.vhosts[host][k] = result.vhosts[host][k];
                        else
                            data.vhosts[host][k] += result.vhosts[host][k];
                    }
                }

                // sum up all of the extapps
                for(var host in result.extapps)
                {
                    if (!data.extapps[host])
                        data.extapps[host] = {};

                    for(var ext in result.extapps[host])
                    {

                        if (!data.extapps[host][ext])
                            data.extapps[host][ext] = {};

                        for(var k in result.extapps[host][ext])
                        {
                            if (!(k in data.extapps[host][ext]))
                                data.extapps[host][ext][k] = result.extapps[host][ext][k];
                            //only sum numeric fields
                            else  if(k != 'TYPE' && k != 'NAME')
                                data.extapps[host][ext][k] += result.extapps[host][ext][k];
                        }
                    }
                }
            }
            return cb(null, data);
        }
    );
}

// get the stats, format the output and send to stdout
function poll(cb)
{
    getReportData(function(err, current)
    {
        if (err)
            return console.error(err);

        var cur = current;

        var httpConnLimit = (cur.MAXCONN) ? (cur.PLAINCONN / cur.MAXCONN).toFixed(4) : 0;
        var httpsConnLimit = (cur.MAXSSL_CONN) ? (cur.SSLCONN / cur.MAXSSL_CONN).toFixed(4) : 0;

        //convert kb to b
        cur.BPS_IN *= 1024;
        cur.BPS_OUT *= 1024;
        cur.SSL_BPS_IN *= 1024;
        cur.SSL_BPS_OUT *= 1024;


        // OVERALL SERVER STATS
        console.log('LS_HTTP_CONNS_USAGE %d %s', httpConnLimit, _source); // percentage
        console.log('LS_HTTP_CONNS %d %s', cur.PLAINCONN, _source);
        console.log('LS_HTTP_IDLE_CONNS %d %s', cur.IDLECONN, _source);

        console.log('LS_SSL_CONNS_USAGE %d %s', httpsConnLimit, _source); // percentage
        console.log('LS_SSL_CONNS %d %s', cur.SSLCONN, _source);
        console.log('LS_SSL_IDLE_CONNS %d %s', diff(cur.AVAILSSL, cur.SSLCONN), _source);

        console.log('LS_HTTP_BYTES_IN %d %s', cur.BPS_IN, _source);
        console.log('LS_HTTP_BYTES_OUT %d %s', cur.BPS_OUT, _source);
        console.log('LS_SSL_BYTES_IN %d %s', cur.SSL_BPS_IN, _source);
        console.log('LS_SSL_BYTES_OUT %d %s', cur.SSL_BPS_OUT, _source);
        console.log('LS_TOTAL_BYTES_IN %d %s', (cur.BPS_IN + cur.SSL_BPS_IN), _source);
        console.log('LS_TOTAL_BYTES_OUT %d %s', (cur.BPS_OUT + cur.SSL_BPS_OUT), _source);

        // PER VHOST STATS
        if (cur.vhosts && Object.keys(cur.vhosts).length > 0)
        {
            var total_cacheHits = 0;
            var total_requests = 0;
            var total_requests_processing = 0;

            var i = 0;
            for(var v in cur.vhosts)
            {
                var cur_host = cur.vhosts[v];
                var vhostname = _vhosts[v];

                var cacheHits =  cur_host.CACHE_HITS_PER_SEC || 0;
                var requests = cur_host.REQ_PER_SEC;
                var cacheRatio = (requests) ? (cacheHits/requests).toFixed(4) : 0 || 0;
                var request_processing = cur_host.REQ_PROCESSING || 0;

                console.log('LS_CACHE_HITS %d %s', cacheHits, _source + '-' + vhostname);
                console.log('LS_CACHE_RATIO %d %s', cacheRatio,_source + '-' + vhostname);
                console.log('LS_REQS %d %s', requests, _source + '-' + vhostname);
                console.log('LS_REQS_PROCESSING %s %s', request_processing, _source + '-' + vhostname);

                total_cacheHits += cacheHits;
                total_requests += requests;
                total_requests_processing += request_processing;

                i++;

                //loop protection for auto
                if(_auto_vhosts_mode && i >= _auto_vhosts_limit) {
                    break;
                }
            }

            console.log('LS_TOTAL_CACHE_HITS %d %s', total_cacheHits, _source);
            console.log('LS_TOTAL_CACHE_RATIO %d %s', total_requests ? (total_cacheHits / total_requests).toFixed(4) : 0, _source);
            console.log('LS_TOTAL_REQS %d %s', total_requests, _source);
            console.log('LS_TOTAL_REQS_PROCSSING %d %s', total_requests_processing, _source);

            var i = 0;
            for(var v in cur.extapps)
            {
                var v_e = cur.extapps[v];
                var vhostname = _vhosts[v];

                for(var e in v_e) {
                    var ext = v_e[e];

                   /* 'Available ExtApp Types are fcgi(Fast CGI App), fcgiauth(Fast CGI Authorizer), lsapi(LSAPI App), servlet(Servlet/JSP Engine), proxy(Web Server)'; */

                    var src = _source + '-' + vhostname + '-' + ext.TYPE + '-' + ext.NAME;

                    console.log('LS_EXT_CMAXCONNS %d %s', ext.CMAXCONN, src);
                    console.log('LS_EXT_EMAXCONNS %d %s', ext.EMAXCONN, src);
                    console.log('LS_EXT_POOL_SIZE %d %s', ext.POOL_SIZE, src);
                    console.log('LS_EXT_INUSE_CONNS %d %s', ext.INUSE_CONN, src);
                    console.log('LS_EXT_IDLE_CONNS %d %s', ext.IDLE_CONN, src);
                    console.log('LS_EXT_QUEUE %d %s', ext.WAITQUE_DEPTH, src);
                    console.log('LS_EXT_REQS %d %s', ext.REQ_PER_SEC, src);
                    console.log('LS_EXT_TOTAL_REQS %d %s', ext.TOT_REQS, src);
                };
                i++;

                //loop protection for auto
                if(_auto_vhosts_mode && i >= _auto_vhosts_limit) {
                    break;
                }

            }
        }
    });

    setTimeout(poll, _pollInterval);
}
poll();
