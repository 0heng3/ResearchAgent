"""OpenAI-compatible HTTP transport; reuse mini2.4.6 stock text-action parser and observations."""
from pathlib import Path
from types import SimpleNamespace
import json,time,urllib.request
from minisweagent.models.utils.actions_text import parse_regex_actions,format_observation_messages
from minisweagent.models.utils.openai_multimodal import expand_multimodal_content
from minisweagent.exceptions import FormatError
ALIAS='researchagent-scaffold-qwen7b'
class HttpTextModel:
 def __init__(self,url,model_cfg):
  self.url=url;self.values=dict(model_cfg);self.values.update(model_name=ALIAS,model_class='http_transport_with_stock_mini_text_parser',api_token_price_usd=0)
  self.config=SimpleNamespace(**self.values)
  self.action_regex=self.values.get('action_regex',r'```mswea_bash_command\s*\n(.*?)\n```')
  self.error_template=self.values.get('format_error_template','Please always provide EXACTLY ONE action in triple backticks, found {{actions|length}} actions.')
  self.observation=self.values.get('observation_template','{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>')
 def query(self,messages,**kwargs):
  wire=[{k:v for k,v in m.items() if k in ['role','content','tool_calls','tool_call_id']} for m in messages]
  req=urllib.request.Request(self.url+'/v1/chat/completions',data=json.dumps({'model':ALIAS,'messages':wire,'stream':True,'temperature':0.4,'max_tokens':4096}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer local-self-hosted'})
  content=[];usage={};finish='stop'
  with urllib.request.urlopen(req,timeout=1250) as r:
   for line in r:
    text=line.decode().strip()
    if not text.startswith('data: '):continue
    if text[6:]=='[DONE]':break
    x=json.loads(text[6:])
    if x.get('error'):raise RuntimeError(x['error'])
    if x.get('usage'):usage=x['usage']
    for c in x.get('choices',[]):
     if c.get('delta',{}).get('content'):content.append(c['delta']['content'])
     if c.get('finish_reason'):finish=c['finish_reason']
  text=''.join(content)
  try:actions=parse_regex_actions(text,action_regex=self.action_regex,format_error_template=self.error_template,template_kwargs={'finish_reason':finish})
  except FormatError as e:
   e.messages[0]['extra'].update(cost=0.,response={'content':text,'usage':usage,'finish_reason':finish});raise
  return {'role':'assistant','content':text,'extra':{'actions':actions,'cost':0.,'usage':usage,'finish_reason':finish,'timestamp':time.time()}}
 def format_message(self,**kwargs):return expand_multimodal_content(kwargs,pattern='')
 def format_observation_messages(self,message,outputs,template_vars=None):return format_observation_messages(outputs,observation_template=self.observation,template_vars=template_vars,multimodal_regex='')
 def get_template_vars(self,**kwargs):return self.values
 def serialize(self):return {'info':{'config':{'model':self.values,'model_type':'HttpTextModel with unchanged stock mini parser/observation utilities'}}}
