#!/usr/bin/env python3
"""Synthetic STDIO-only app-server. No sockets, auth files or provider access.
This fixture records method NAMES only. Never record request JSON or tokens.
A test prepends SCENARIO and EVENTS constants to its disposable copy.
"""
import base64
import json
import os
import signal
import sys
from pathlib import Path

stopping = False
awaiting_refresh_reply = False
def stop(_signal, _frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
def record(name):
    with open(EVENTS, 'a', encoding='utf8') as output:
        output.write(name + '\n')
def emit(value):
    sys.stdout.write(json.dumps(value) + '\n'); sys.stdout.flush()
def reply(request, value):
    emit({'id': request['id'], 'result': value})
access = ''
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method is None:
        record('refresh_response_denied' if request.get('error', {}).get('code') == -32001 else 'unexpected_response')
        break
    record(method)
    if method == 'initialize':
        assert request['params']['capabilities']['experimentalApi'] is True
        if SCENARIO == 'early_exit': sys.exit(7)
        reply(request, {'userAgent': 'fixture-codex-0.160.0'})
    elif method == 'initialized':
        pass
    elif method == 'account/login/start':
        params = request['params']; assert params['type'] == 'chatgptAuthTokens'
        assert set(params) == {'type', 'accessToken', 'chatgptAccountId', 'chatgptPlanType'}
        assert params['chatgptAccountId'] == 'fixture-account'
        access = params['accessToken']
        # Provider children must not retain a second descriptor for the ingress.
        assert 'PAPERCLIP_CODEX_EXTERNAL_AUTH_FD' not in os.environ
        if SCENARIO == 'auth_response_timeout':
            pass
        elif SCENARIO == 'malformed_provider_frame':
            sys.stdout.write('{invalid:'+access+'\n');sys.stdout.flush()
        elif SCENARIO == 'refresh_pending':
            awaiting_refresh_reply = True
            emit({'id': 'refresh-1', 'method': 'account/chatgptAuthTokens/refresh', 'params': {'reason':'unauthorized','previousAccountId':'fixture-account'}})
        elif SCENARIO in ('reflect_raw', 'reflect_base64'):
            material = base64.b64encode(access.encode()).decode() if SCENARIO == 'reflect_base64' else access
            sys.stderr.write(material + '\n'); sys.stderr.flush()
            emit({'id':request['id'],'error':{'code':401,'message':material}})
        elif SCENARIO == 'silent_exit':
            sys.stderr.write(access + '\n'); sys.stderr.flush(); sys.exit(8)
        else:
            reply(request, {'type':'chatgptAuthTokens'})
            emit({'method':'account/login/completed','params':{'loginId':None,'success':True,'error':None}})
            emit({'method':'account/updated','params':{'authMode':'chatgptAuthTokens','planType':'team'}})
    elif method == 'account/read':
        assert request['params'] == {'refreshToken':False}
        reply(request, {'account': None if SCENARIO == 'account_missing' else {'type':'chatgpt','planType':'team'},'requiresOpenaiAuth':True})
    elif method in ('thread/start','thread/resume'):
        if SCENARIO == 'refresh_thread_pending':
            awaiting_refresh_reply = True
            emit({'id':'refresh-thread','method':'account/chatgptAuthTokens/refresh','params':{'reason':'unauthorized'}})
        else:
            reply(request, {'thread':{'id':'thread-fixture','sessionId':'session-fixture'}})
    elif method == 'thread/read':
        reply(request, {'thread':{'id':'thread-fixture','status':{'type':'idle'},'turns':[]}})
    elif method == 'turn/start':
        reply(request, {'turn':{'id':'turn-fixture'}})
        if SCENARIO == 'refresh_async':
            awaiting_refresh_reply = True
            emit({'id':99,'method':'account/chatgptAuthTokens/refresh','params':{'reason':'unauthorized','previousAccountId':'fixture-account'}})
        elif SCENARIO == 'reflect_async':
            emit({'method':'item/agentMessage/delta','params':{'threadId':'thread-fixture','turnId':'turn-fixture','delta':access}})
        elif SCENARIO == 'http401_async':
            emit({'method':'turn/completed','params':{'threadId':'thread-fixture','turn':{'id':'turn-fixture','error':{'httpStatusCode':401,'message':'fixture details withheld'}}}})
    elif method == 'account/logout':
        record('FORBIDDEN_LOGOUT'); sys.exit(3)
    else:
        reply(request, {})
    if stopping and not awaiting_refresh_reply: break
