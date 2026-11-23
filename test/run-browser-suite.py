#!/usr/bin/env python3
"""Run browser checks using a separately seeded, disposable DB for each file.

Requires Python Playwright and an installed Chromium plus OS libraries. It never
uses an existing database or the live server. Optionally set MAVI_BROWSER_TESTS
(comma-separated file names) to run a subset. The temporary databases are removed.
"""
from pathlib import Path
import os, socket, subprocess, sys, tempfile, time, urllib.request

ROOT=Path(__file__).resolve().parent.parent
TESTS=['browser-alert-links.py','browser-cart-responsive.py','browser-custom-alerts.py',
       'browser-order-costs.py','browser-order-costs-edges.py','browser-reports-receipts.py',
       'browser-order-lifecycle.py','browser-admin-redesign.py','browser-office-ui.py']
if os.environ.get('MAVI_BROWSER_TESTS'):
    requested=os.environ['MAVI_BROWSER_TESTS'].split(',')
    if any(x not in TESTS for x in requested):raise SystemExit('Unknown browser test name')
    TESTS=requested
(ROOT/'data').mkdir(exist_ok=True)
logs=[];fail=[]
for test in TESTS:
    with tempfile.TemporaryDirectory(prefix='mavi-browser-fixture-',dir=ROOT/'data') as temp:
        db=Path(temp)/'synthetic.db'
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        base='http://127.0.0.1:'+str(port)
        env=os.environ.copy();env.update(DB_PATH=str(db),PORT=str(port),SHOW_OTP='0',AUTO_SEED='0',NODE_ENV='test',MAVI_BROWSER_DB=str(db),MAVI_BROWSER_BASE=base)
        seed=subprocess.run(['node','src/seed.js'],cwd=ROOT,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        if seed.returncode:
            fail.append(test);logs.append('=== '+test+' seed FAILED ===\n'+seed.stdout);print('FAIL',test,flush=True);continue
        server=subprocess.Popen(['node','src/bootstrap.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            deadline=time.monotonic()+20
            while True:
                if server.poll() is not None:raise RuntimeError('fixture server exited')
                try:
                    with urllib.request.urlopen(base+'/healthz',timeout=2) as r:
                        if r.status==200:break
                except OSError:pass
                if time.monotonic()>deadline:raise RuntimeError('fixture server did not start')
                time.sleep(.1)
            run=subprocess.run([sys.executable,str(ROOT/'test'/test)],cwd=ROOT,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
            logs.append('=== '+test+' exit '+str(run.returncode)+' ===\n'+run.stdout+'\n')
            print(('PASS' if run.returncode==0 else 'FAIL'),test,flush=True)
            if run.returncode:fail.append(test)
        except Exception as e:
            logs.append('=== '+test+' FAILED ===\n'+repr(e)+'\n');fail.append(test);print('FAIL',test,str(e),flush=True)
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()
logpath=ROOT/'data'/'browser-regression.log';logpath.write_text(''.join(logs),encoding='utf8')
print(f'{len(TESTS)-len(fail)}/{len(TESTS)} browser test files passed; log: {logpath}')
if fail:print('Failures:',', '.join(fail));sys.exit(1)
