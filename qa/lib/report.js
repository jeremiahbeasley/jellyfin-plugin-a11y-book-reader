// Tiny shared reporter for the QA suites.
function print(suite, results) {
  console.log('=== ' + suite + ' ===');
  for (const r of results) {
    console.log((r.pass ? 'PASS' : 'FAIL').padEnd(5) + r.name + (r.detail ? '  — ' + r.detail : ''));
  }
  const failed = results.filter(r => !r.pass).length;
  console.log('SUMMARY ' + (results.length - failed) + '/' + results.length + ' passed' +
    (failed ? ', ' + failed + ' FAILED' : ''));
  return failed;
}
// For a script run directly: print and exit non-zero on any failure.
async function runMain(runFn, suite) {
  try {
    const results = await runFn();
    const failed = print(suite, results);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('SUITE ERROR:', e.message);
    process.exit(2);
  }
}
module.exports = { print, runMain };
