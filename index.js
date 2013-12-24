var _async = require('async');
var _fs = require('fs');
var _os = require('os');
var _param = require('./param.json');
var _path = require('path');

var _pollInterval; // polling interval
var _reportPath; // the directory with the litespeed files
var _reports = []; // litespeed writes a file per core 
var _source; // the source of the metrics
var _vhosts = {}; // the virtual hosts to monitor, if none, show all with limit set by _auto_vhosts_limit

var _auto_vhosts_limit = _param.auto_vhosts_limit || 20; //if vhosts are not set and in auto mode, how many should we show?
var _auto_vhosts_mode = true; //are we in auto vhosts mode

var _enable_vhost_req = _param.enableVhostReq || false;
var _enable_vhost_ext = _param.enableVhostExt || false;


// ==========
// CONFIG & VALIDATION
// ==========

// set the reportPath if we do not have one
_reportPath = _param.reportPath || '/tmp/lshttpd';

// set the pollTime if we do not have one
if(_param.pollInterval) _param.pollIntervalCustom *= 1000;

_pollInterval = _param.pollIntervalCustom || 1000;
if(_pollInterval < 1000) _pollInterval = 1000; //any lower than 1s is meaningless

//default to to full host name or partial if partialHostname is set to true
if(_param.partialHostname)
    _source = (_param.source || _os.hostname()).trim().split('.')[0]; // get the metric source
else
    _source = (_param.source || _os.hostname()).trim(); // get the metric source

// now check if the individual CPU files exist
for(var i=1; i<_os.cpus().length; i++)
    if (_fs.existsSync(_path.join(_reportPath, '.rtreport.' + i)))
        _reports.push(_path.join(_reportPath, '.rtreport.' + i));

// if we have a set of vhosts, add them in
if (_param.vhosts_filter){
    _param.vhosts_filter.forEach(function(vh) {
        if (!vh)
            return;

        var value = vh.split('|');
        var host = value[0];
        var alias = value[1];
		
        _vhosts[host] = (alias || host).trim(); // if there is an alias use it

        if(auto_vhosts_mode)
            _auto_vhosts_mode = false;
    });
}

//global vhost
_vhosts[''] = 'Global';

function parseReport(reportPath, cb){
    try {
        _fs.readFile(reportPath, {encoding: 'utf8'}, function(err, file){
            if (err)
                return cb(err);
            if (!file)
                return cb(null, {});

            var data;

            try {
                data = JSON.parse(file);
            }
            //must likely we are reading a partially written json file
            catch (e) {
                return cb(null, {});
            }
         
            return cb(null, data);
        });
    }
    catch(e){
        return cb(e);
    }
}

// call the socket object to get the statistics
function getReportData(cb){
    var funcs = _reports.map(function(reportPath) { return function(innerCb) { parseReport(reportPath, innerCb); }; });
    _async.parallel(
        funcs,
        function(err, results)
        {
            if (err)
                return cb(err);
            if (!results || results.length == 0)
                return cb(null, {});

            // pick index 0 to use as the base
            var data = results[0];

            if (!data)
                return cb(null, {});

            // go through every result (off by 1 as 0 is our base)
            for(var i=1; i<results.length; i++){
                var result = results[i];

                //bad data
                if (!results || Object.keys(results).length === 0)
                    continue;

                Object.keys(result).forEach(function(k){
                    //bad data
                    if(!(k in data)) {
                        data[k] = result[k];
                        return;
                    }

					if( k == "GLOBAL" ) {
						Object.keys(result[k]).forEach(function(key){
							data[k][key] += result.GLOBAL[key];
						});
					}
					else if( k == "REQUEST" || k == "EXTAPP" ) {
						for(var j = result[k].length - 1; j; j--){
							e = result[k][j];

                            //due to multicore, ext/requeset might exist in one core but not the other
                            if( !(j in data[k]) ) {
                                data[k][j] = e;
                                continue;
                            }

							Object.keys(e).forEach(function(key){
								if( key != "TYPE" && key != "VHOST" && key != "NAME" ){
									data[k][j][key] += e[key];
								}								
							});
						}					
					}					                   
                });
            }
			
            return cb(null, data);
        }
    );
}

// get the stats, format the output and send to stdout
function poll(cb){
    getReportData(function(err, cur){
        if (err)
            return console.error(err);

        var httpConnLimit = (cur.GLOBAL.HTTP_CONN_MAX) ? ( (cur.GLOBAL.HTTP_CONN_ACTIVE + cur.GLOBAL.HTTP_CONN_IDLE) / cur.GLOBAL.HTTP_CONN_MAX * 100).toFixed(0) : 0;
        var httpsConnLimit = (cur.GLOBAL.SSL_CONN_MAX) ? (cur.GLOBAL.SSL_CONN_ACTIVE / cur.GLOBAL.SSL_CONN_MAX * 100).toFixed(0) : 0;

        console.log('LS_HTTP_CONN_USAGE %d %s', httpConnLimit, _source); // percentage
        console.log('LS_HTTP_CONN_ACTIVE %d %s', cur.GLOBAL.HTTP_CONN_ACTIVE, _source);
        console.log('LS_HTTP_CONN_IDLE %d %s', cur.GLOBAL.HTTP_CONN_IDLE, _source);
		console.log('LS_HTTP_CONN_FREE %d %s', cur.GLOBAL.HTTP_CONN_FREE, _source);

        console.log('LS_SSL_CONN_USAGE %d %s', httpsConnLimit, _source); // percentage
        console.log('LS_SSL_CONN_ACTIVE %d %s', cur.GLOBAL.SSL_CONN_ACTIVE, _source);
		console.log('LS_SSL_CONN_FREE %d %s', cur.GLOBAL.SSL_CONN_FREE, _source);

        console.log('LS_HTTP_TRAFFIC_IN %d %s', cur.GLOBAL.HTTP_TRAFFIC_IN, _source);
        console.log('LS_HTTP_TRAFFIC_OUT %d %s', cur.GLOBAL.HTTP_TRAFFIC_OUT, _source);
        console.log('LS_SSL_TRAFFIC_IN %d %s', cur.GLOBAL.SSL_TRAFFIC_IN, _source);
        console.log('LS_SSL_TRAFFIC_OUT %d %s', cur.GLOBAL.SSL_TRAFFIC_OUT, _source);
        console.log('LS_ALL_TRAFFIC_IN %d %s', (cur.GLOBAL.HTTP_TRAFFIC_IN + cur.GLOBAL.SSL_TRAFFIC_IN), _source);
        console.log('LS_ALL_TRAFFIC_OUT %d %s', (cur.GLOBAL.HTTP_TRAFFIC_OUT + cur.GLOBAL.SSL_TRAFFIC_OUT), _source);
		
		console.log('LS_ALL_REQ_COUNT %d %s', cur.GLOBAL.REQ_COUNT, _source);
        console.log('LS_ALL_REQ_RATE %d %s', cur.GLOBAL.REQ_RATE, _source);
		console.log('LS_ALL_REQ_ACTIVE %d %s', cur.GLOBAL.REQ_ACTIVE, _source);
			
		//REQUEST loop
        if(_enable_vhost_req) {
            for(var i = cur.REQUEST.length - 1, c = 0; i; i--){
                var req = cur.REQUEST[i];
                var src = _source + '-Req-' + req.VHOST;

                if(!_auto_vhosts_mode && !(req.VHOST in _vhosts))
                    continue;

                console.log('LS_REQ_COUNT %d %s', req.REQ_COUNT, src);
                console.log('LS_REQ_RATE %d %s', req.REQ_RATE, src);
                console.log('LS_REQ_ACTIVE %s %s', req.REQ_ACTIVE, src);

                //loop protection for auto
                if(_auto_vhosts_mode && c >= _auto_vhosts_limit)
                    break;

                c++;
            }
        }

		//EXTAPP loop
        if(_enable_vhost_ext) {
            for(var i = cur.EXTAPP.length - 1, c = 0; i; i--){
                var ext = cur.EXTAPP[i];

                var src = _source + "-Ext-" + (ext.VHOST.length ? ext.VHOST : "Global") + "-" + ext.NAME;

                if( ext.VHOST != "" && !_auto_vhosts_mode && !(ext.VHOST in _vhosts))
                    continue;

                console.log('LS_EXT_CMAX %d %s', ext.CMAX, src);
                console.log('LS_EXT_EMAX %d %s', ext.EMAX, src);
                console.log('LS_EXT_POOL %d %s', ext.POOL, src);
                console.log('LS_EXT_ACTIVE %d %s', ext.ACTIVE, src);
                console.log('LS_EXT_IDLE %d %s', ext.IDLE, src);
                console.log('LS_EXT_QUEUE %d %s', ext.QUEUE, src);
                console.log('LS_EXT_REQ_RATE %d %s', ext.REQ_RATE, src);
                console.log('LS_EXT_REQ_COUNT %d %s', ext.REQ_COUNT, src);

                //loop protection for auto
                if(_auto_vhosts_mode && c >= _auto_vhosts_limit)
                    break;

                c++;
            }
        }
    });
	
    setTimeout(poll, _pollInterval);
}
poll();
