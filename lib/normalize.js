// Accepts either XML data or the report object
// from nightwatch and returns a normalized
// object structure.
/*
  run: {
    isFailure: t or f
    packages: [{
      name: 'name',
      tests: number of tests
      failures: number of ailures
      isFailure: t or f
      suites: [{
        name: 'name',
        pkgName: 'name from pkg',
        passed: number of tests passed
        failures: number of test failures
        errors: number of test errors
        skipped: number skipped,
        cases: [{
          isFailure: t or f,
          message: 'assertion message',
          stacktrace: empty string or stack trace,
          failure: false or failure message,
          screenshots: ['path/to/screen1', '/path/to/screen2']
        }]
      }]
    }]
  }
*/
var _ = require('lodash'),
    TestRun = require('./models/testRun'),
    logger = require('./logger'),
    getRelativePath = require('./relativePath');

function getScreenshotPaths(sysout) {
  var re = /\[\[ATTACHMENT\|([^\]]*)\]\]/g;
  var result = [], matches = [];

  while (matches = re.exec(sysout[0])) {
    result.push(matches[1]);
  }

  return result;
}

function concatErrMessages(concatTo, errs) {
  return _.uniq(concatTo.concat(_.map(errs, _.trim)));
}

function parse(str) {
  return _.isNaN(str) ? 0 : parseInt(str, 10);
}

var normalizers = {

  // Converts a object parsed from XML report files
  // into models.
  xml: function(results, run, options, done) {
    _.each(results, function(result) {
      var pkg = {
          errors  : parse(result.testsuites.$.errors),
          failures: parse(result.testsuites.$.failures),
          name    : result.testsuites.$.name,
          suites  : [],
          tests   : parse(result.testsuites.$.tests)
      };
      pkg.isFailure = pkg.failures > 0;

      var filename = result.filename;
      _.each(result.testsuites.testsuite, function(suiteData) {
        var $ = suiteData.$;

        /** @var {array|boolean} */
        var systemError = suiteData['system-err'] || false;

        var suite = {
            name    : $.name,
            pkgName : $.package,
            failures: parse($.failures),
            errors  : parse($.errors),
            skipped : parse($.skipped),
            tests   : parse($.tests),
            cases   : []
        };

        // Sometimes the package name isn't in the
        // xml reports...
        if (!pkg.name) {
          if (result.testsuites.filename) {
            pkg.name = result.testsuites.filename;
          } else {
            pkg.name = suite.pkgName;
          }
        } else {
          if (result.testsuites.filename) {
            pkg.name = result.testsuites.filename + '-' + pkg.name;
          }
        }

        suite.passed = suite.tests - suite.errors - suite.failures;
        suite.isFailure = suite.errors > 0 || suite.failures > 0;
        suite.errmessages = $['system-err'];
        pkg.suites.push(suite);

        _.each(suiteData.testcase, function(caseData) {

          var assert = {
              message    : caseData.$.name,
              time       : caseData.$.time,
              stacktrace : '',
              failure    : false,
              errors     : false,
              skipped    : false,
              screenshots: []

            // failure: false or failure message,
            // screenshots: ['path/to/screen1', '/path/to/screen2']
          };

          if (caseData.skipped) assert.skipped = true;

          if (caseData.failure && caseData.failure.length > 0) assert.failure = caseData.failure[0].$.message;

          if (caseData.errors && caseData.errors.length > 0) assert.errors = caseData.errors[0].$.message;

          if (caseData['system-out']) {
            var sspaths = getScreenshotPaths(caseData['system-out']);

            sspaths.map(function(sspath) {
              if (options.relativeScreenshots) {
                sspath = getRelativePath(options.fullOutputFilename, sspath);
              }
              assert.screenshots.push(sspath);
            });
          }

            assert.isFailure = assert.failure;
            assert.isErrors  = assert.errors;
          suite.cases.push(assert);

          if (assert.isFailure) suite.isFailure = true;
          if (assert.isErrors) suite.isErrors = true;
        });

         if (suite.isFailure) pkg.isFailure = true;
         if (suite.isErrors) pkg.isErrors = true;

        if (systemError) {
          // Add system-error output
          if (false === suite.cases[0]['failure']) {
              suite.cases[0]['failure'] = '';
          }

          // Normalize system-errors (remove information irrelevant for summary-report)
          var errorList = systemError[0].split('ERROR:');
          var prefix    = errorList[0];

          errorList[0] = '';
          for (var i = 0; i < errorList.length; i++) {
            errorList[i] = errorList[i].split(' using: css selector')[0];
          }

          systemError[0] = prefix + errorList.join('ERROR:');

          // Add system-errors into report
          suite.cases[0]['failure'] += systemError[0];
          suite.cases[0]['isFailure'] = systemError[0];
        }
      });

      run.addPackage(pkg);

    });

    done(null, run);
  },

  // Converts an object given to us by nightwatch
  // into models.
  latest: function(results, run, options, done) {

    run.errmessages = concatErrMessages(run.errmessages, results.errmessages);
    _.forOwn(results.modules, function(pkg, pkgName) {

      var npkg = {
          errors   : pkg.errors,
          failures : pkg.failures,
          isFailure: (pkg.failures !== 0 && pkg.errors !== 0),
          name     : pkgName,
          suites   : [],
          tests    : pkg.tests
      };

      _.forOwn(pkg.completed, function(suite, suiteName) {

        var nsuite = {
            cases   : [],
            errors  : suite.errors,
            failures: suite.failed,
            name    : suiteName,
            passed  : suite.passed,
            pkgName : npkg.name,
            skipped : suite.skipped,
            time    : suite.time
        };

        // Little weird here but the report object
        // will not report an error, it will instead
        // have X failed and empty assertions array.
        if (nsuite.failures > 0 && suite.assertions.length === 0)
          nsuite.errors = nsuite.failures;

        if (nsuite.errors > 0 && suite.assertions.length === 0)
          nsuite.failures = nsuite.errors;

        nsuite.isFailure = nsuite.failures !== 0 || nsuite.errors !== 0;
        npkg.suites.push(nsuite);

        _.each(suite.assertions, function(assertion) {

          var assert = _.clone(assertion, true);
          assert.screenshots = assert.screenshots || [];
          assert.isFailure = assertion.failure;
          assert.isErrors = assertion.errors;
          nsuite.cases.push(assert);

          if (options.relativeScreenshots) {
            assert.screenshots = assert.screenshots.map(function(sspath) {
              return getRelativePath(options.fullOutputFilename, sspath);
            });
          }

          if (assert.isFailure)
            nsuite.isFailure = true;

          if (assert.isErrors)
            nsuite.isErrors = true;

        });

        if (nsuite.isFailure)
          npkg.isFailure = true;

        if (nsuite.isErrors)
          npkg.isErrors = true;

      });

      run.addPackage(npkg);

      if (npkg.isFailure)
        run.isFailure = npkg.isFailure;

      if (npkg.isErrors)
        run.isErrors = npkg.isErrors;

    });

    done(null, run);

  }

};

module.exports = function(options, data, callback) {

  var opts = _.defaults({}, options, { fromXML: false, hideSuccess: false });
  var testRun = new TestRun(opts);

  return normalizers[(opts.fromXML) ? 'xml' : 'latest'](data, testRun, opts, callback);

};
