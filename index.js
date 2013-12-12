var _async = require('async');
var _fs = require('fs');
var _os = require('os');
var _param = require('./param.json');
var _path = require('path');
var _tools = require('graphdat-plugin-tools');

var IGNORE_LIST = ['VERSION', 'UPTIME', 'BLOCKED_IP', 'EOF'];

var _pollInterval; // the interval to poll the metrics
var _reportPath; // the directory with the litespeed files
var _reports = []; // litespeed writes a file per core depnding on your licence
var _source; // the source of the metrics
var _vhosts = {}; // the virtual hosts to monitor

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
if (_param.virtualHosts)
{
    _param.virtualHosts.forEach(function(vh)
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
        _vhosts[host] = _source + '-' + (alias || host).trim(); // if there is an alias use it
    });
}

// if we do not have any virtual hosts to filter by, use the global vhost
if (Object.keys(_vhosts).length === 0)
   _vhosts[''] = _source;

// ================
// HELPER FUNCTIONS
// ================

// get the natural sum between a and b
function sum(a, b)
{
    if ((a == null || isNaN(a)) && (!isNaN(b)))
        return b;
    else if ((b == null || isNaN(b)) && (!isNaN(a)))
        return a;
    else
        return Math.max(a + b, 0);
}

// get the natural difference between a and b
function diff(a, b)
{
    if (a == null || b == null || isNaN(a) || isNaN(b))
        return 0;
    else
        return Math.max(a - b, 0);
}

// convert to a float if possible
function parse(x)
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
        var kvp = data.match(/(\w+):\s*(\d+)?/);
        if (!kvp)
            break;

        result[kvp[1].toUpperCase()] = parse(kvp[2]);
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
        --- sample litespeed config ---
        VERSION: LiteSpeed Web Server/Enterprise/4.2.4
        UPTIME: 03:24:02
        BPS_IN: 0, BPS_OUT: 0, SSL_BPS_IN: 0, SSL_BPS_OUT: 0
        MAXCONN: 2000, MAXSSL_CONN: 200, PLAINCONN: 0, AVAILCONN: 2000, IDLECONN: 0, SSLCONN: 0, AVAILSSL: 200
        REQ_RATE []: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 30, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 03
        REQ_RATE [_AdminVHost]: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 26, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 0
        REQ_RATE [Example]: REQ_PROCESSING: 0, REQ_PER_SEC: 0.0, TOT_REQS: 4, CACHE_HITS_PER_SEC: 0.0, TOTAL_CACHE_HITS: 0
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
            var data = { vhosts:{} };
            lines.toString().split('\n').forEach(function(line)
            {
                if (!line)
                    return;

                // Ignore any keys on the ignore list
                var key = line.split(':')[0];
                if (!key || IGNORE_LIST.indexOf(key) !== -1)
                    return;

                // For most data we just do a simple KVP addition
                var destination = data;
                var toParse = line;

                // REQ_RATE is the `key` if we are dealing with a VHOST,
                // which is checked against the filter list
                if (key.indexOf('REQ_RATE') === 0)
                {
                    // do we have a vhost
                    var match = line.match(/REQ_RATE \[(.*)\].*/);
                    if (!match)
                        return;

                    // filter out the vhosts we dont care about
                    var vhost = match[1];
                    if (!_vhosts[vhost])
                        return;

                    // get the KVPs of the vhost
                    match = line.match(/REQ_RATE \[.*\]:(.*)/);
                    if (!match)
                        return;

                    if (!data.vhosts[vhost])
                        data.vhosts[vhost] = {};

                    destination = data.vhosts[vhost];
                    toParse = match[1];
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
                    // we treat vhosts differently, will do them in the next pass
                    if (key === 'vhosts')
                        return;

                    if (!(key in data))
                        data[key] = result[key];
                    else
                        data[key] += result[key];
                });

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

        var httpConnLimit = (cur.MAXCONN) ? (cur.PLAINCONN / cur.MAXCONN) : 0;
        var httpsConnLimit = (cur.MAXSSL_CONN) ? (cur.SSLCONN / cur.MAXSSL_CONN) : 0;

        // OVERALL SERVER STATS
        console.log('LITESPEED_HTTP_CONNECTION_LIMIT %d %s', httpConnLimit, _source); // percentage
        console.log('LITESPEED_HTTP_CONNECTIONS %d %s', cur.PLAINCONN, _source);
        console.log('LITESPEED_HTTP_IDLE_CONNECTIONS %d %s', cur.IDLECONN, _source);

        console.log('LITESPEED_HTTPS_CONNECTION_LIMIT %d %s', httpsConnLimit, _source); // percentage
        console.log('LITESPEED_HTTPS_CONNECTIONS %d %s', cur.SSLCONN, _source);
        console.log('LITESPEED_HTTPS_IDLE_CONNECTIONS %d %s', diff(cur.AVAILSSL, cur.SSLCONN), _source);

        console.log('LITESPEED_HTTP_BYTES_IN %d %s', cur.BPS_IN, _source);
        console.log('LITESPEED_HTTP_BYTES_OUT %d %s', cur.BPS_OUT, _source);
        console.log('LITESPEED_HTTPS_BYTES_IN %d %s', cur.SSL_BPS_IN, _source);
        console.log('LITESPEED_HTTPS_BYTES_OUT %d %s', cur.SSL_BPS_OUT, _source);
        console.log('LITESPEED_TOTAL_BYTES_IN %d %s', sum(cur.BPS_IN + cur.SSL_BPS_IN), _source);
        console.log('LITESPEED_TOTAL_BYTES_OUT %d %s', sum(cur.BPS_OUT + cur.SSL_BPS_OUT), _source);

        // PER VHOST STATS
        if (cur.vhosts && Object.keys(cur.vhosts).length > 0)
        {
            for(var v in cur.vhosts)
            {
                var cur_host = cur.vhosts[v];
                var hostname = _vhosts[v];

                var cacheHits =  cur_host.CACHE_HITS_PER_SEC || 0;
                var requests = cur_host.REQ_PER_SEC;
                var cacheRatio = (requests) ? cacheHits/requests : 0 || 0;

                console.log('LITESPEED_CACHE_HITS %d %s', cacheHits, hostname);
                console.log('LITESPEED_CACHE_RATIO %d %s', cacheRatio, hostname);
                console.log('LITESPEED_REQUESTS %d %s', requests, hostname);
                console.log('LITESPEED_REQUESTS_IN_PROCESS %s %s', cur_host.REQ_PROCESSING, hostname);
            }
        }
    });

    setTimeout(poll, _pollInterval);
}
poll();
