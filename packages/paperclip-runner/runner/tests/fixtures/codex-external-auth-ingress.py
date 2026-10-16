#!/usr/bin/env python3
"""Synthetic-only anonymous-pipe source. No profiles, providers or networks."""
import argparse,base64,json,os,subprocess,threading,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--probe',type=Path,required=True);a=p.parse_args();probe=a.probe.resolve(strict=True)
if probe.name!='codex-external-auth-ingress' or not probe.is_file():p.error('Use only the synthetic Rust example')
now=int(time.time()*1000)
r={'schema':'paperclip.codex-external-auth.v1','authorityId':'synthetic-authority','capabilityId':'synthetic-capability','companyId':'740ad7ee-0c28-4e07-b9d1-ca7b35da820d','profileRef':'fixture@example.invalid','chatgptAccountId':'synthetic-account','chatgptPlanType':'team','runId':'synthetic-run','environmentLeaseId':'synthetic-lease','normalizedSessionId':'synthetic-session','runnerInstanceId':'synthetic-runner','admittedUntilUnixMs':now+60000}
def enc(v):return base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=')
claims={'exp':now//1000+600,'https://api.openai.com/auth':{'chatgpt_account_id':'synthetic-account','chatgpt_plan_type':'team'}}
token=b'.'.join((enc({'alg':'none','typ':'JWT'}),enc(claims),b'synthetic-signature-not-an-account-token'))
body=bytearray(json.dumps({'reference':r,'accessToken':token.decode(),'accessTokenExpiresAtUnixMs':(now//1000+600)*1000},separators=(',',':')).encode())
read_fd,write_fd=os.pipe2(os.O_CLOEXEC);os.fchmod(read_fd,0o600);errors=[];child=None;writer=None
def write_once():
 try:
  n=0
  while n<len(body):n+=os.write(write_fd,body[n:])
 except OSError:errors.append('synthetic_pipe_write_failed')
 finally:os.close(write_fd);body[:]=b'\0'*len(body)
try:
 child=subprocess.Popen([str(probe),'--synthetic-only'],env={'PATH':'/usr/bin:/bin','PAPERCLIP_CODEX_EXTERNAL_AUTH_FD':str(read_fd)},pass_fds=(read_fd,),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 os.close(read_fd);read_fd=-1;writer=threading.Thread(target=write_once,daemon=True);writer.start()
 output,error=child.communicate(timeout=10);writer.join(timeout=1)
 if child.returncode or errors or writer.is_alive():raise RuntimeError('Synthetic ingress failed; details withheld')
 result=json.loads(output)
 if result != {'result':'pass','scope':'synthetic_ingress_only','providerSpawned':False,'accountAuthenticationProved':False}: raise RuntimeError('Synthetic result differs')
 print(json.dumps(result))
finally:
 if read_fd>=0:os.close(read_fd)
 if writer is None:os.close(write_fd)
 if child is not None and child.poll() is None:child.kill();child.wait(timeout=5)
