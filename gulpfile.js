var gulp = require('gulp'),
    jshint = require('gulp-jshint'),
    jshintStylish = require('jshint-stylish'),
    Q = require('q'),
    runSequence = Q.denodeify(require('run-sequence')),
    path = require('path'),
    _ = require('lodash'),
    args   = require('yargs').argv,
    urlLib = require('url'),
    SpawnMocha = require('spawn-mocha-parallel'),
    through = require('through'),
    httpProxy = require('http-proxy'),
    sauceConnectLauncher = require('sauce-connect-launcher'),
    async = require('async');

require('./test/helpers/env');

args.browsers = (args.browser || 'chrome').split(',');
args.sauce = args.sauce ? true : false;

var BROWSERS = ['chrome', 'firefox', 'explorer'];
var MOBILE_BROWSERS = ['android', 'ios', 'iphone', 'ipad', 'android_phone'];
process.env.SAUCE_CONNECT_VERSION = process.env.SAUCE_CONNECT_VERSION || '4.3';
process.env.SAUCE_CONNECT_VERBOSE = false;

var PROXY_PORT = 5050;
var expressPort = 3000; // incremented after each test to avoid colision

function mocha(opts) {
  var spawnMocha = new SpawnMocha(opts);
  var stream = through(function write(file) {
    spawnMocha.add(file.path);
  }, function() {});
  var errors = [];
  spawnMocha.on('error', function(err) {
    console.error(err.toString());
    errors.push(err);
  }).on('end', function() {
    if(errors.length > 0) {
      console.error('ERROR SUMMARY: ');
      _(errors).each(function(err) {
        console.error(err.toString());
      });
      stream.emit('error', "Some tests failed.");
    }
    stream.emit('end');
  });
  return stream;
}

function buildMochaOpts(opts) {
  
  var mochaOpts = {
    flags: {
      u: 'bdd-with-opts',
      R: 'spec',
      b: true,
      //R: 'nyan',      
    },
    bin: path.join(__dirname,  'node_modules/.bin/mocha'),
    concurrency: args.concurrency | process.env.CONCURRENCY || 3
  };  
  if(args.grep) {
    mochaOpts.flags.g = args.grep;
  }
  mochaOpts.env = function() {
    var env = _.clone(process.env);
    if(opts.unit) {
      // unit test
      delete env.SAUCE;
      delete env.SAUCE_USERNAME;
      delete env.SAUCE_ACCESS_KEY;    
    } else {
      // midway + e2e tests
      env.BROWSER = opts.browser;
      env.SAUCE = args.sauce;
    }
    if(opts.midway) {
      // local server port
      env.EXPRESS_PORT = expressPort;
      expressPort++;
      if(env.SAUCE) {
        env.MIDWAY_ROOT_URL = 'http://127.0.0.1:' + PROXY_PORT + '/' +
          env.EXPRESS_PORT;
      }
      if(process.env.TRAVIS_JOB_NUMBER) {
        env.TUNNEL_IDENTIFIER  = process.env.TRAVIS_JOB_NUMBER;
      }    
    }
    return env;
  };
  return mochaOpts;
}

gulp.task('lint', function() {
//  return gulp.src(['lib/**/*.js','test/**/*.js','browser-scripts/**/*.js'])
  return gulp.src(['lib/**/*.js'])
    .pipe(jshint())
    .pipe(jshint.reporter(jshintStylish))
    .pipe(jshint.reporter('fail'));
});

gulp.task('test-unit', function () {
  var opts = buildMochaOpts({ unit: true });
  return gulp.src('test/specs/**/*-specs.js', {read: false})
    .pipe(mocha(opts))
    .on('error', console.warn.bind(console));
});

gulp.task('test-midway-multi', function () {
  var opts = buildMochaOpts({ midway: true, browser: 'multi' });
  return gulp.src('test/midway/multi/**/*-specs.js', {
    read: false})
    .pipe(mocha(opts))
    .on('error', console.warn.bind(console));
});

_(BROWSERS).each(function(browser) {
  gulp.task('test-midway-' + browser, function () {
    var opts = buildMochaOpts({ midway: true, browser: browser });
    return gulp.src([
        'test/midway/**/*-specs.js',
        '!test/midway/multi/**'
      ], {read: false})
      .pipe(mocha(opts))
      .on('error', console.warn.bind(console));      
  });
  gulp.task('test-e2e-' + browser, function () {
    var opts = buildMochaOpts({ browser: browser });
    return gulp.src('test/e2e/**/*-specs.js', {read: false})
      .pipe(mocha(opts))
      .on('error', console.warn.bind(console));
  });
});

_(MOBILE_BROWSERS).each(function(browser) {
  gulp.task('test-midway-' + browser, function () {
    var opts = buildMochaOpts({ midway: true, browser: browser });
    return gulp.src([
      'test/midway/api-nav-specs.js',
      'test/midway/api-el-specs.js',
      'test/midway/api-exec-specs.js',
      'test/midway/mobile-specs.js',
    ], {read: false})
    .pipe(mocha(opts))
    .on('error', console.warn.bind(console));
  });
});

gulp.task('test-midway', function() {
  var midwayTestTasks = [];
  _(args.browsers).each(function(browser) {
    midwayTestTasks.push('test-midway-' + browser);    
  });
  return runSequence('pre-midway', midwayTestTasks)
    .finally(function() {
      return runSequence('post-midway');  
    });
});

gulp.task('test-e2e', function() {
  var e2eTestTasks = [];
  _(args.browsers).chain().without('multi').each(function(browser) {
    e2eTestTasks.push('test-e2e-' + browser);    
  });
  if(e2eTestTasks.length > 0){
    return runSequence(e2eTestTasks);
  }
});

gulp.task('test', function() {
  var seq = ['lint', 'test-unit', 'test-midway-multi'];
  _(BROWSERS).each(function(browser) {
     seq.push('test-midway-' + browser);
     seq.push('test-e2e-' + browser);
  });
  return runSequence.apply(null, seq);
});

var server;
gulp.task('start-proxy', function(done) {
  var proxy = httpProxy.createProxyServer({});

  var proxyQueue = async.queue(function(task, done) {

    proxy.web(task.req, task.res, { target: 'http://127.0.0.1:' + task.port });
    task.res.on('finish', function() {
      done();
    });
  }, 5);
  server = require('http').createServer(function(req, res) {
    try {
      if(req.url.match(/^\/favicon/)) {
        res.write("404 Not Found\n");
        res.end();
        return;
      }
      // extracting port from url and rewriting url
      var url = urlLib.parse(req.url);
      var re = /\/(.*?)\//;
      var m = re.exec(url.pathname);
      var port = parseInt(m[1]);
      url.pathname = url.pathname.replace(re, '/');
      req.url = url.format();
      proxyQueue.push({req: req, res: res, port: port});
    } catch (err) {
      try{
        console.error('Proxy error for: ', req.url + ':' , err);
        res.writeHead(500, {
          'Content-Type': 'text/plain'
        });
        res.end('Something went wrong.');
      } catch (ign) {}
    }
  });

  server.on('error', function(err) {
    console.error('Proxy error: ', err);
  });

  console.log("listening on port", PROXY_PORT);
  server.listen(PROXY_PORT, done);
});

gulp.task('stop-proxy', function(done) {
  // stop proxy, exit after 5 ec if hanging
  done = _.once(done);
  var t = setTimeout(function() {
    done();
  }, 5000);
  if(server) { 
    server.close(function() {
      clearTimeout(t);
      done();
    }); 
  }
  else { done(); }
});

var sauceConnectProcess = null;

gulp.task('start-sc', function(done) {
  var opts = {
    username: process.env.SAUCE_USERNAME,
    accessKey: process.env.SAUCE_ACCESS_KEY,    
    //verbose: process.env.SAUCE_CONNECT_VERBOSE,
    directDomains: 'cdnjs.cloudflare.com,html5shiv.googlecode.com',
    logger: function(mess) {console.log(mess);}
  };
  if(process.env.TRAVIS_JOB_NUMBER) {
    opts.tunnelIdentifier = process.env.TRAVIS_JOB_NUMBER;
  }
  sauceConnectLauncher(opts, function (err, _sauceConnectProcess) {
    if (err) {
      console.error(err.message);
      done(err);
      return;
    }
    sauceConnectProcess = _sauceConnectProcess;
    console.log("Sauce Connect ready");
    done();
  });
});

gulp.task('stop-sc', function(done) {
  if(sauceConnectProcess) { sauceConnectProcess.close(done); }
  else { done(); }
});

gulp.task('pre-midway', function() {
  if(args.sauce && !args['nosc']) {
    return runSequence('start-sc', 'start-proxy');
  }
});

gulp.task('post-midway', function() {
  if(args.sauce && !args['nosc']) {
    return runSequence('stop-sc', 'stop-proxy');
  }
});

gulp.task('travis', function() {
  var seq;
  switch(args.config) {
    case 'unit':
      return runSequence(['test-unit']);
    case 'multi':
      args.browsers= [args.config];
      return runSequence(['test-midway']);
    case 'chrome':
    case 'firefox':
    case 'explorer':
      args.browsers= [args.config];
      return runSequence(['test-midway','test-e2e']);
    case 'iphone':
    case 'ipad':
      args.browsers= [args.config];
      return runSequence(['test-midway']);
    case 'chrome_e2e':
      args.browsers= ['chrome'];
      return runSequence(['test-e2e']);
  }
  return runSequence.apply(null, seq);
});
