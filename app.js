// ── Supabase Config (extracted to top-level — used by signOut, uploadFiles, and cloud sync) ──
const SUPABASE_URL='https://ehuttijifubonhhgnvzx.supabase.co';
const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodXR0aWppZnVib25oaGdudnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjU2MTgsImV4cCI6MjA5NTA0MTYxOH0.-uYE8sxRDXdZXt00CH10d7tLYaJl03hFYfDH5tPjTKM';

// ── Cloud sync state ──
let _sb=null,_sbUser=null,_syncTimer=null,_syncStatus='local';
let _cloudFailCount=0;// BATCH 3: consecutive cloud-save failures (toast on 3rd)

// ── XSS-safe HTML escaping (used in all template literals that interpolate user data) ──
const _ESC_MAP={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'};
function esc(s){if(s==null)return'';return String(s).replace(/[&<>"'`=\/]/g,c=>_ESC_MAP[c]);}

// ════════ BATCH 3: Toast notifications ════════
// toast(msg, kind, opts) — kind: 'info'|'success'|'warn'|'error'
// opts.action + opts.onAction → action button; opts.duration → auto-dismiss ms
// (default 4000 info/success/warn, 6000 error; 0 = manual). Returns dismiss().
function toast(msg, kind, opts){
  kind=kind||'info'; opts=opts||{};
  const c=document.getElementById('toast-container');
  if(!c){return function(){};}
  const el=document.createElement('div');
  el.className='toast toast-'+kind;
  const m=document.createElement('div');
  m.className='toast-msg';
  m.textContent=(msg==null?'':String(msg));
  el.appendChild(m);
  let timer=null;
  function dismiss(){
    if(el._dismissed)return; el._dismissed=true;
    if(timer)clearTimeout(timer);
    el.classList.add('toast-leaving');
    setTimeout(function(){el.remove();},220);
  }
  if(opts.action){
    const b=document.createElement('button');
    b.className='toast-action'; b.type='button';
    b.textContent=opts.action;
    b.onclick=function(){ try{opts.onAction&&opts.onAction();}finally{dismiss();} };
    el.appendChild(b);
  }
  const x=document.createElement('button');
  x.className='toast-close'; x.type='button';
  x.setAttribute('aria-label','Dismiss notification');
  x.innerHTML='&times;';
  x.onclick=dismiss;
  el.appendChild(x);
  c.appendChild(el);
  const dur=(opts.duration!=null)?opts.duration:(kind==='error'?6000:4000);
  if(dur>0){timer=setTimeout(dismiss,dur);}
  return dismiss;
}

// ════════ BATCH 3: Custom dialog (replaces confirm/prompt) ════════
// Single shared resolver — opening a new dialog cancels the previous one.
let _dlgActive=null;
function _dlgOpen(o){
  const isPrompt=!!o.prompt;
  if(_dlgActive){ const a=_dlgActive; _dlgActive=null; a.cleanup(); a.resolve(a.isPrompt?null:false); }
  return new Promise(function(resolve){
    const _prevFocus=document.activeElement;
    const bd=document.getElementById('dlg-backdrop');
    const tEl=document.getElementById('dlg-title');
    const bEl=document.getElementById('dlg-body');
    const inp=document.getElementById('dlg-input');
    const ok=document.getElementById('dlg-btn-confirm');
    const cancel=document.getElementById('dlg-btn-cancel');
    if(!bd||!ok||!cancel){ resolve(isPrompt?null:false); return; }
    tEl.textContent=o.title||'';
    bEl.textContent=o.body||'';
    ok.textContent=o.confirmLabel||'Confirm';
    cancel.textContent=o.cancelLabel||'Cancel';
    ok.className='dlg-btn '+(o.danger?'dlg-btn-danger':'dlg-btn-confirm');
    if(isPrompt){ inp.style.display='block'; inp.value=''; inp.placeholder=o.placeholder||''; }
    else { inp.style.display='none'; }
    function cleanup(){
      ok.onclick=null; cancel.onclick=null;
      document.removeEventListener('keydown',onKey,true);
      bd.setAttribute('data-open','0');
    }
    function finish(val){
      if(_dlgActive&&_dlgActive.resolve===resolve)_dlgActive=null;
      cleanup();
      if(_prevFocus&&_prevFocus.focus){ try{_prevFocus.focus();}catch(_){} }
      resolve(val);
    }
    function doConfirm(){
      if(isPrompt){
        const v=inp.value;
        if(o.expectedText!=null && v!==o.expectedText){ finish(null); toast('Text did not match — action cancelled.','warn'); return; }
        finish(v);
      } else { finish(true); }
    }
    function doCancel(){ finish(isPrompt?null:false); }
    function onKey(e){
      if(e.key==='Escape'){ e.preventDefault(); finish(isPrompt?null:false); return; }
      if(e.key==='Enter'&&isPrompt){ e.preventDefault(); doConfirm(); return; }
      if(e.key==='Tab'){
        const f=[...bd.querySelectorAll('button,input,[tabindex]')].filter(el=>el.getClientRects().length>0&&!el.disabled);
        if(!f.length)return;
        const first=f[0],last=f[f.length-1];
        if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
      }
    }
    ok.onclick=doConfirm; cancel.onclick=doCancel;
    document.addEventListener('keydown',onKey,true);
    _dlgActive={resolve:resolve,cleanup:cleanup,isPrompt:isPrompt};
    bd.setAttribute('data-open','1');
    setTimeout(function(){ if(isPrompt){inp.focus();}else{ok.focus();} },50);
  });
}
function dlgConfirm(opts){ return _dlgOpen(Object.assign({},opts||{},{prompt:false})); }
function dlgPrompt(opts){ return _dlgOpen(Object.assign({},opts||{},{prompt:true})); }

// ════════ BATCH 3: safeAwait helper ════════
async function safeAwait(promise, label){
  try{ return await promise; }
  catch(e){ console.error('['+(label||'async')+']', e); toast('Something went wrong'+(label?' ('+label+')':'')+'. Your changes are saved locally.', 'error'); return undefined; }
}

// ════════ BATCH 4: Event delegation (replaces all inline on* handlers) ════════
// Listeners are attached ONCE to document, so they survive every renderView() rebuild.
const CLICK_ACTIONS={
  nav:el=>go(el.dataset.target),
  toggleRemy:()=>toggleRemy(),
  signOut:()=>signOut(),
  togglePF:()=>togglePF(),
  showEditEntry:el=>showEditEntry(el.dataset.id),
  delEntry:el=>delEntry(el.dataset.id),
  saveEditEntry:el=>saveEditEntry(el.dataset.id),
  hideEditEntry:el=>{const x=document.getElementById('edit-entry-'+el.dataset.id);if(x)x.style.display='none';},
  toggleEditProp:el=>toggleEditProp(el.dataset.id),
  dismissSettingsBanner:()=>{const b=document.getElementById('set-banner');if(b)b.style.display='none';try{localStorage.setItem('rr_settings_banner','1');}catch(e){}},
  chartTab:el=>{_chartTab=el.dataset.tab;renderView();},
  showImportModal:()=>showImportModal(),
  downloadImportTemplate:()=>downloadImportTemplate(),
  triggerClick:el=>{const t=document.getElementById(el.dataset.targetId);if(t)t.click();},
  closeImportModal:()=>closeImportModal(),
  confirmImport:()=>confirmImport(),
  setTT:el=>setTT(el.dataset.arg),
  toggleTimer:()=>toggleTimer(),
  submitEntry:()=>submitEntry(),
  logFilterType:el=>setLogFilter('type',el.dataset.arg),
  bulkDelete:()=>bulkDelete(),
  clearLogFilter:()=>{logFilter={type:'all',propId:'',search:''};renderView();},
  delAttachment:el=>delAttachment(el.dataset.id,el.dataset.name),
  openAtt:el=>openAtt(el),
  dupeEntry:el=>dupeEntry(el.dataset.id),
  dupePrevDay:()=>dupePrevDay(),
  addProp:()=>addProp(),
  openQuickLog:el=>openQuickLog(el.dataset.id),
  togglePropEntries:el=>togglePropEntries(el.dataset.id),
  toggleBookingLog:el=>toggleBookingLog(el.dataset.id),
  rmProp:el=>rmProp(el.dataset.id),
  saveQuickLog:el=>saveQuickLog(el.dataset.id),
  hideQuickLog:el=>{const x=document.getElementById('quick-log-'+el.dataset.id);if(x)x.style.display='none';},
  savePropEdit:el=>savePropEdit(el.dataset.id),
  addBooking:el=>addBooking(el.dataset.id),
  delBooking:el=>delBooking(el.dataset.id,el.dataset.id2),
  fillAddr:el=>fillAddr(parseInt(el.dataset.idx)),
  printPage:()=>window.print(),
  exportXLSX:()=>exportXLSX(),
  exportTimeLog:()=>exportTimeLog(),
  resetAll:()=>resetAll(),
  closeWalkthrough:()=>closeWalkthrough(),
  walkBack:()=>walkBack(),
  walkNext:()=>walkNext(),
  remySend:()=>remySend(),
};
const CHANGE_ACTIONS={
  setYear:el=>{activeYear=parseInt(el.value);renderView();},
  importFile:el=>handleImportFile(el),
  previewFiles:el=>previewFiles(el),
  logFilterProp:el=>setLogFilter('propId',el.value),
  selectAll:el=>selectAllEntries(el.checked),
  selEntry:el=>toggleSelEntry(el.dataset.id,el.checked),
  togglePropType:()=>togglePropType(),
  updateQLCats:el=>updateQLCats(el.dataset.id),
  toggleEditPropType:el=>toggleEditPropType(el.dataset.id),
  togMP:el=>togMP(el.dataset.id,parseInt(el.dataset.tid),el.checked),
  setNum:el=>setSetting(el.dataset.key,parseFloat(el.value)||0),
  setStr:el=>setSetting(el.dataset.key,el.value),
  setStrRender:el=>{setSetting(el.dataset.key,el.value);renderView();},
  setBool:el=>setSetting(el.dataset.key,el.checked),
  setBoolRender:el=>{setSetting(el.dataset.key,el.checked);renderView();},
  setStrRenderSB:el=>{setSetting(el.dataset.key,el.value);renderView();updateSB();},
};
const INPUT_ACTIONS={
  logFilterSearch:el=>setLogFilter('search',el.value),
  addrSearch:el=>addrSearch(el.value),
};
function _delegate(type,attr,registry){
  document.addEventListener(type,function(e){
    const t=e.target.closest('['+attr+']');
    if(!t)return;
    const fn=registry[t.getAttribute(attr)];
    if(!fn)return;
    if(t.dataset.prevent==='1')e.preventDefault();
    try{ fn(t,e); }catch(err){ console.error('[delegate '+type+']',err); }
  });
}
let _delegationReady=false;
function initDelegation(){
  if(_delegationReady)return; _delegationReady=true;
  _delegate('click','data-act',CLICK_ACTIONS);
  _delegate('change','data-chg',CHANGE_ACTIONS);
  _delegate('input','data-inp',INPUT_ACTIONS);
  document.addEventListener('keydown',function(e){
    const t=e.target.closest('[data-kd]');
    if(!t)return;
    const kind=t.getAttribute('data-kd');
    if(kind==='activate'){ if(e.key==='Enter'||e.key===' '){e.preventDefault();t.click();} }
    else if(kind==='remyKey'){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();remySend();} }
  });
}

// ════════ BATCH 4: §1411 NIIT MAGI thresholds (statutory, not inflation-indexed) ════════
const NIIT_THRESHOLDS={MFJ:250000,QW:250000,Single:200000,HoH:200000,MFS:125000};
const FILING_LABELS={MFJ:'Married filing jointly',Single:'Single',MFS:'Married filing separately',HoH:'Head of household',QW:'Qualifying surviving spouse'};

// ════════ BATCH 4: Duplicate previous day ════════
async function dupePrevDay(){
  const today=todayStr();
  const dates=[...new Set(state.entries.map(e=>e.date))].filter(d=>d&&d<today).sort();
  if(!dates.length){ toast('No earlier day with entries to copy.','warn'); return; }
  const src=dates[dates.length-1];
  const dayEntries=state.entries.filter(e=>e.date===src);
  const ok=await dlgConfirm({title:'Duplicate previous day',body:`Copy all ${dayEntries.length} ${dayEntries.length===1?'entry':'entries'} from ${src} to today (${today})?\n\nEvidence attachments are not copied.`,confirmLabel:'Copy to today'});
  if(!ok)return;
  const added=dayEntries.map(e=>({...e,id:uid(),date:today,attachments:[]}));
  state.entries.push(...added);
  save();renderView();
  toast(`Copied ${added.length} ${added.length===1?'entry':'entries'} to today.`,'success',{duration:6000,action:'Undo',onAction:()=>{const ids=new Set(added.map(a=>a.id));state.entries=state.entries.filter(e=>!ids.has(e.id));save();renderView();toast('Copy undone.','info');}});
}

// ════════ BATCH 4: Time Log export (current filter) ════════
async function exportTimeLog(){
  const _done=toast('Preparing time log…','info',{duration:0});
  try{
    if(!window.XLSX){
      await new Promise((res,rej)=>{const sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';sc.onload=res;sc.onerror=()=>rej(new Error('Could not load Excel library — check your connection'));document.head.appendChild(sc);});
    }
    let rows=[...yearEntries()].sort((a,b)=>new Date(b.date)-new Date(a.date));
    if(logFilter.type!=='all')rows=rows.filter(e=>e.trackType===logFilter.type);
    if(logFilter.propId)rows=rows.filter(e=>e.propertyId===logFilter.propId);
    if(logFilter.search){const q=logFilter.search.toLowerCase();rows=rows.filter(e=>(e.notes||'').toLowerCase().includes(q)||(e.category||'').toLowerCase().includes(q));}
    if(!rows.length){ _done(); toast('No entries match the current filter.','warn'); return; }
    const pName=e=>state.properties.find(p=>p.id===e.propertyId)?.name||'General RE';
    const fmtHM=h=>{const a=Math.floor(h),b=Math.round((h-a)*60);return b===0?`${a}h`:`${a}h ${b}m`;};
    const header=['Date','Property','Type','Category','Hours (decimal)','Hours (formatted)','Spouse','Notes'];
    const body=rows.map(e=>[e.date,pName(e),e.trackType,e.category||'',Math.round((e.hours||0)*100)/100,fmtHM(e.hours||0),e.isSpouse?'Yes':'',e.notes||'']);
    const total=rows.reduce((s,e)=>s+(e.hours||0),0);
    body.push(['','','','','','','','']);
    body.push(['TOTAL','','','',Math.round(total*100)/100,fmtHM(total),'','']);
    const ws=XLSX.utils.aoa_to_sheet([header,...body]);
    ws['!cols']=[{wch:12},{wch:22},{wch:8},{wch:30},{wch:14},{wch:14},{wch:8},{wch:50}];
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Time Log');
    const fn=`RepsRecord_${activeYear}_TimeLog_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb,fn);
    _done();
    toast(`Time log downloaded (${rows.length} ${rows.length===1?'entry':'entries'}).`,'success');
  }catch(err){ _done(); console.error('[exportTimeLog]',err); toast(err.message||'Could not export time log.','error'); }
}

// ── Tax-law thresholds (centralized — see citations) ──
const TAX={
  REPS_HOURS_MIN:750,            // §469(c)(7)(B)(ii) — MORE than 750 hours
  REPS_SERVICES_PCT:50,          // §469(c)(7)(B)(i) — MORE than 50%
  MP_TEST1_HOURS:500,            // §1.469-5T(a)(1) — MORE than 500 hours
  MP_TEST3_HOURS:100,            // §1.469-5T(a)(3) — MORE than 100 hours
  MP_TEST4_SPA_FLOOR:100,        // §1.469-5T(c)(2) — MORE than 100 hours for SPA
  MP_TEST4_AGG:500,              // §1.469-5T(a)(4) — SPA aggregate >500 hours
  MP_TEST7_MIN:100,              // §1.469-5T(b)(2)(iii) — MORE than 100 hours required for Test 7
  STR_AVG_DAYS:7,                // §1.469-1T(e)(3)(ii)(A) — average rental period ≤7 days
  STR_MID_DAYS:30,               // §1.469-1T(e)(3)(ii)(B) — 8–30 days with significant personal services
};

const SK='repsrecord_v1';
const CUR_YEAR=new Date().getFullYear();
const YEARS=[CUR_YEAR-3,CUR_YEAR-2,CUR_YEAR-1,CUR_YEAR];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const REPS_CATS=['— General REPS Hours (Real Estate Professional Activity)','Acquisition & Due Diligence','Property Management','Leasing & Marketing','Maintenance & Repairs','Construction & Development','Financial & Accounting','Legal & Compliance','Tenant Communication','Contractor Coordination','Education & Research (must support active operations — not investor monitoring)','Travel (property-related, active purpose)','Property Selling','Other Qualifying Activity'];
const STR_CATS=['— Material Participation Hours (STR Active Management)','Guest Communication','Booking & Reservation Management','Check-in / Check-out','Cleaning Coordination','Maintenance & Repairs','Marketing & Listing Management','Financial & Accounting','Furnishing & Setup','Travel (STR property)','Guest Services & Concierge','Other STR Activity'];
const NAV=[{id:'dashboard',ic:'📊',label:'Dashboard'},{id:'properties',ic:'🏠',label:'Properties'},{id:'log',ic:'⏱',label:'Log Time'},{id:'mp',ic:'✅',label:'MP Tests'},{id:'reports',ic:'📋',label:'Audit Report'},{id:'divider'},{id:'ltr',ic:'🏡',label:'REPS Rules'},{id:'str',ic:'🏖',label:'STR Rules'},{id:'settings',ic:'⚙️',label:'Settings'}];

let state={settings:{nonREPSHours:0,spouseEnabled:false,spouseName:'',groupingElection:false,includeSTRinREPS:false,personalUseDays:0,filingStatus:'MFJ',spouseHoursPolicy:'majority'},properties:[],entries:[],manualMP:{}};
let activeYear=CUR_YEAR;
let view='dashboard',chartInst=null,showPropForm=false,trackType='REPS';
// Feature state
let logFilter={type:'all',propId:'',search:''};
let timerStart=null,timerTick=null;
let selEntries=new Set();
let _chartTab='monthly';// 'monthly' | 'property'
// Remy AI assistant
let remyOpen=false,remyLoading=false;
let remyMessages=[];// {role:'user'|'assistant', content:string}
const REMY_SK='repsrecord_remy_v1';

function uid(){return Math.random().toString(36).slice(2,9);}
function fmtH(h){const a=Math.floor(h),b=Math.round((h-a)*60);return b===0?`${a}h`:`${a}h ${b}m`;}
function todayStr(){return new Date().toISOString().slice(0,10);}

// ── Auth ──
async function signOut(){
  if(_sb){try{await _sb.auth.signOut();}catch(e){}}
  window.location.href='login.html';
}

// ── Paywall gate ──
// Accounts that always have access (never locked out). Owner addresses go here.
const PAYWALL_ADMINS=['admin@repsrecord.com','support@repsrecord.com','support@themoneynista.com'];
const PAY_MONTHLY='https://buy.stripe.com/bJedR19mL8bK7rY3nuebu00';
const PAY_ANNUAL='https://buy.stripe.com/aFadR17eD9fOfYubU0ebu01';
// Returns 'ok' | 'blocked' | 'redirect' | 'open'. Fails OPEN on any error so a
// transient glitch can never lock a legitimate user out of their own data.
async function enforceSubscription(){
  try{
    if(!_sb) return 'open';                       // library didn't load → don't strand
    const{data:{session}}=await _sb.auth.getSession();
    if(!session){
      // Only redirect to the sign-in page if we're not already on it,
      // so an unauthenticated state can never cause a reload loop.
      if(!/(^|\/)login\.html$/.test(location.pathname)){
        window.location.replace('login.html');
      }
      return 'redirect';
    }
    const email=(session.user.email||'').toLowerCase();
    if(PAYWALL_ADMINS.includes(email)) return 'ok';
    let status=null;
    try{
      const res=await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${session.user.id}&select=status`,{
        headers:{'Authorization':`Bearer ${session.access_token}`,'apikey':SUPABASE_ANON_KEY,'Accept':'application/json'}
      });
      if(!res.ok) return 'open';                   // query error → fail open
      const rows=await res.json();
      status=rows.length?rows[0].status:null;
    }catch(e){ return 'open'; }                     // network error → fail open
    if(['trialing','active','past_due'].includes(status)) return 'ok';
    showPaywallOverlay(session.user.id, session.user.email||'');
    return 'blocked';
  }catch(e){ return 'open'; }
}
function showPaywallOverlay(userId,email){
  if(document.getElementById('paywall-overlay'))return;
  const ref=`?client_reference_id=${encodeURIComponent(userId)}&prefilled_email=${encodeURIComponent(email)}`;
  const o=document.createElement('div');
  o.id='paywall-overlay';
  o.setAttribute('style','position:fixed;inset:0;z-index:99999;background:#0D1F3C;color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit;');
  o.innerHTML=`<div style="max-width:440px;width:100%;background:#13294B;border:1px solid #1E3A63;border-radius:16px;padding:32px;text-align:center;box-sizing:border-box;">
    <div style="font-size:40px;margin-bottom:8px;">🔒</div>
    <h2 style="margin:0 0 8px;font-size:22px;">Your access is paused</h2>
    <p style="margin:0 0 20px;color:#B6C6E0;font-size:15px;line-height:1.5;">Your free trial or subscription isn't active right now. Choose a plan to pick up right where you left off — your data is safe and waiting.</p>
    <a href="${PAY_MONTHLY}${ref}" style="display:block;background:#14B8A6;color:#fff;text-decoration:none;font-weight:600;padding:13px;border-radius:10px;margin-bottom:10px;">Continue — Monthly</a>
    <a href="${PAY_ANNUAL}${ref}" style="display:block;background:#0EA5E9;color:#fff;text-decoration:none;font-weight:600;padding:13px;border-radius:10px;">Continue — Annual</a>
    <button id="paywall-signout" type="button" style="margin-top:18px;background:none;border:none;color:#7C93B8;font-size:13px;cursor:pointer;text-decoration:underline;">Sign out</button>
  </div>`;
  document.body.appendChild(o);
  const so=document.getElementById('paywall-signout');
  if(so) so.addEventListener('click',signOut);
}

// ── CRITICAL FIX 1: Cloud sync ──
// Syncs user data to Supabase user_data table.
// Requires running supabase_migration.sql in your Supabase SQL editor first.
// Falls back gracefully to localStorage if table missing or network offline.
function updateSyncIndicator(){
  const el=document.getElementById('sync-indicator');
  if(!el)return;
  // BATCH 3: [text, color, tooltip, toastKind] per status
  const map={
    syncing:['⟳ Syncing…','#7DD3FC','Saving your latest changes to the cloud…','info'],
    synced:['☁ Synced','#14B8A6','Your data is backed up to the cloud and synced across your devices.','success'],
    local:['⚠ Local only','#F59E0B','Your data is saved on this device only. Sign in to back it up to the cloud.','warn'],
    offline:['📴 Offline','#94A3B8','You appear to be offline. Changes are saved locally and will sync when you reconnect.','info']
  };
  const e=map[_syncStatus]||map.local;
  const txt=e[0],col=e[1],tip=e[2],kind=e[3];
  el.textContent=txt;el.style.color=col;el.title=tip;
  el.onclick=function(){ toast(tip,kind,{duration:6000}); };
}

async function cloudLoad(){
  if(!_sbUser||!_sb)return null;
  try{
    const{data:{session}}=await _sb.auth.getSession();
    if(!session)return null;
    const res=await fetch(`${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${_sbUser.id}&select=data`,{
      headers:{'Authorization':`Bearer ${session.access_token}`,'apikey':SUPABASE_ANON_KEY,'Accept':'application/json'}
    });
    if(!res.ok)return null;
    const rows=await res.json();
    return rows.length?rows[0].data:null;
  }catch(e){return null;}
}

async function cloudSave(){
  if(!_sbUser||!_sb){_syncStatus='local';updateSyncIndicator();return;}
  _syncStatus='syncing';updateSyncIndicator();
  try{
    const{data:{session}}=await _sb.auth.getSession();
    if(!session){_syncStatus='local';updateSyncIndicator();return;}
    const res=await fetch(`${SUPABASE_URL}/rest/v1/user_data`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${session.access_token}`,'apikey':SUPABASE_ANON_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'},
      body:JSON.stringify({user_id:_sbUser.id,data:state,updated_at:new Date().toISOString()})
    });
    if(res.ok){
      _cloudFailCount=0;
      _syncStatus='synced';
    } else {
      _cloudFailCount++;
      _syncStatus='local';
      if(_cloudFailCount===3) toast('Cloud sync is having trouble. Your data is still saved on this device.','warn',{duration:6000});
    }
  }catch(e){
    _cloudFailCount++;
    _syncStatus='local';
    console.error('[cloudSave]',e);
    if(_cloudFailCount===3) toast('Cloud sync is having trouble. Your data is still saved on this device.','warn',{duration:6000});
  }
  updateSyncIndicator();
}

async function load(){
  // Try cloud first when authenticated
  if(_sbUser&&_sb){
    const cloudData=await cloudLoad();
    if(cloudData){
      try{
        state=cloudData;
        if(state.properties){state.properties.forEach(p=>{if(!p.bookings)p.bookings=[];});}
        if(!state.manualMP)state.manualMP={};
        // BATCH 2: forward-compat defaults for new settings
        if(state.settings){
          if(state.settings.personalUseDays==null)state.settings.personalUseDays=0;
          if(!state.settings.filingStatus)state.settings.filingStatus='MFJ';
          if(!state.settings.spouseHoursPolicy)state.settings.spouseHoursPolicy='majority';
        }
        localStorage.setItem(SK,JSON.stringify(state));// mirror to localStorage as offline cache
        _syncStatus='synced';updateSyncIndicator();
        return;
      }catch(e){}
    }
  }
  // Fall back to localStorage
  try{
    const s=localStorage.getItem(SK);
    if(s){
      state=JSON.parse(s);
      if(state.properties){state.properties.forEach(p=>{if(!p.bookings)p.bookings=[];});}
      if(!state.manualMP)state.manualMP={};
      // BATCH 2: forward-compat defaults for new settings
      if(state.settings){
        if(state.settings.personalUseDays==null)state.settings.personalUseDays=0;
        if(!state.settings.filingStatus)state.settings.filingStatus='MFJ';
        if(!state.settings.spouseHoursPolicy)state.settings.spouseHoursPolicy='majority';
      }
    }
  }catch(e){}
  // If authenticated but no cloud data yet, push local data up automatically
  if(_sbUser&&_sb){
    _syncStatus='local';
    updateSyncIndicator();
    cloudSave();// first-login push — uploads localStorage to cloud
  } else {
    _syncStatus='local';
    updateSyncIndicator();
  }
}

let _localFailCount=0;
function save(){
  try{
    localStorage.setItem(SK,JSON.stringify(state));
    _localFailCount=0;
  }catch(e){
    _localFailCount++;
    console.error('[save] localStorage write failed',e);
    // Surface only after repeated failures to avoid noise on a transient hiccup.
    if(_localFailCount===3) toast('Couldn\u2019t save to this device\u2019s storage (it may be full or in private mode). '+(_sbUser?'Your data is still syncing to the cloud.':'Sign in to back up your data so nothing is lost.'),'warn',{duration:8000});
  }
  // Debounce cloud push — wait 1.5s after last change
  clearTimeout(_syncTimer);
  _syncTimer=setTimeout(cloudSave,1500);
}

function yearEntries(){return state.entries.filter(e=>e.date&&e.date.startsWith(String(activeYear)));}

function calcREPS(){
  const inc=state.settings.includeSTRinREPS===true;
  const ye=yearEntries();
  // L8 fix: count all qualifying hours regardless of whether the property still
  // exists. Entries can become orphaned (propertyId points to a deleted property)
  // via cross-device sync; those hours were real qualifying work and must not
  // silently drop out of the 750-hour REPS total.
  // AUDIT FIX (Pass 6 #C, tightened Pass 7): STR hours feed the 750-hr REPS total ONLY when the
  // property fully qualifies under the STR exception — strQualifies==='yes', i.e. average rental
  // period <=7 days AND the user materially participates. Toggling the setting on does NOT sweep in
  // hours from STRs held passively, that fail the period test, or that are merely "conditional"
  // (8-30 day band pending significant personal services). This is the stricter reading and matches
  // the on-screen condition ("only if you materially participate ... not merely as passive owner").
  // (Note: an STR entry orphaned to a deleted property no longer counts here, since qualification
  // can no longer be established for it.)
  const strOK=inc?new Set(state.properties.filter(p=>p.type==='STR'&&strQualifies(p)==='yes').map(p=>p.id)):null;
  const rh=ye.filter(e=>!e.isSpouse&&(e.trackType==='REPS'||e.trackType==='LTR'||(inc&&e.trackType==='STR'&&strOK&&strOK.has(e.propertyId)))).reduce((s,e)=>s+(e.hours||0),0);
  const th=rh+(state.settings.nonREPSHours||0);
  const pct=th>0?rh/th*100:0;
  // AUDIT FIX (Critical #2): the 50% personal-services test cannot be verified until the
  // user enters their non-RE hours. A zero/blank figure (with RE hours present) is treated
  // as UNVERIFIED, not an automatic pass — otherwise REPS reports "Qualified" when it may
  // not be. m50 keeps the raw math (so the dashboard "UNVERIFIED" badge still renders);
  // only the overall qualification verdict (ok) is gated on the test being verifiable.
  const incomplete50=(state.settings.nonREPSHours||0)===0&&rh>0;
  return{rh,pct,m750:rh>750,m50:pct>50,incomplete50,ok:rh>750&&pct>50&&!incomplete50};
}

function pH(pid){
  // H1 fix: material participation is determined per taxable year (§1.469-5T),
  // so owner/spouse hours must be scoped to the active year — not lifetime totals.
  const ye=yearEntries();
  return{owner:ye.filter(e=>e.propertyId===pid&&!e.isSpouse).reduce((s,e)=>s+(e.hours||0),0),
         spouse:ye.filter(e=>e.propertyId===pid&&e.isSpouse).reduce((s,e)=>s+(e.hours||0),0)};
}

// AUDIT FIX (Pass 4 #1): Test 7 — corrected to reflect §1.469-5T(b)(2)(iii) which DOES
// impose a >100-hour minimum and disqualifying conditions in §1.469-5T(b)(2)(ii).
// AUDIT FIX (Pass 4): hour thresholds use > ("more than 500/100 hours"). AUDIT FIX (Pass 5):
// the Test 3/7 "not less than any other individual" comparison uses >= (a tie qualifies), per §1.469-5T(a)(3)/(b)(2)(ii).
// AUDIT FIX (Pass 6 #A/#J): spouseHoursPolicy now controls ONLY the Tests 3/7 "other individual"
// comparison; spouse hours are always attributed to the taxpayer (see body). Default is 'majority'
// (the §469(h)(5) regulatory position), matching the in-app rules pages and the Settings copy.
//   'majority'     — spouse hours add to taxpayer's; spouse is NOT "any other individual".
//                    Other-individuals = p.otherHours only.
//   'conservative' — spouse hours still add to the taxpayer's, but are ALSO counted on the
//                    others' side of Tests 3/7: other-individuals = max(spouse, otherHours).
function mpT(pid){
  const ph=pH(pid),p=state.properties.find(x=>x.id===pid)||{},mn=(state.manualMP||{})[pid]||{};
  const policy=(state.settings&&state.settings.spouseHoursPolicy)||'majority';
  // AUDIT FIX (Pass 6 #A): §469(h)(5) and §1.469-5T(f)(3) require a spouse's participation to be
  // "taken into account" for EVERY material-participation test — this is mandatory, not a
  // practitioner option. Spouse hours therefore ALWAYS add to the taxpayer's own count
  // (Test 1's >500 floor and the >100 floors of Tests 3 & 7). The majority/conservative
  // choice affects ONLY the "any other individual" comparison in Tests 3 & 7 — i.e. whether
  // the spouse is ALSO counted on the others' side. It must never zero the spouse out of ownerEff.
  const ownerEff=ph.owner+(ph.spouse||0);
  // "Other individuals" hours for the Test 3 / Test 7 comparison:
  //   majority     — spouse is treated as the taxpayer, not an "other individual": others = p.otherHours.
  //   conservative — some practitioners still count the spouse on the others' side (defensive only).
  const mo=policy==='conservative'?Math.max(ph.spouse||0,p.otherHours||0):(p.otherHours||0);
  // AUDIT FIX (Pass 6 #B): Test 7 (facts & circumstances) is UNAVAILABLE when any other person is
  // COMPENSATED to manage the activity (§1.469-5T(b)(2)(ii)). otherHoursCompensated flags a paid
  // co-host / property manager. When set with logged other-hours, Test 7 cannot be auto-met.
  const paidManager=!!p.otherHoursCompensated&&(p.otherHours||0)>0;
  return[
    {id:1,name:'Test 1',label:'500 Hours',cite:'§1.469-5T(a)(1)',desc:'More than 500 hours in this activity during the year.',auto:true,met:ownerEff>TAX.MP_TEST1_HOURS},
    {id:2,name:'Test 2',label:'Substantially All',cite:'§1.469-5T(a)(2)',desc:'Substantially all participation in the activity was yours. "Substantially all" is not quantified in the regulation; practitioners commonly use a 95%+ safe harbor (others combined < 5%).',auto:false,met:!!mn[2]},
    {id:3,name:'Test 3',label:'100 Hrs + Most',cite:'§1.469-5T(a)(3)',desc:'More than 100 hours AND not less than any other individual\u2019s participation in the activity (including paid staff).',auto:true,met:ownerEff>TAX.MP_TEST3_HOURS&&ownerEff>=mo},
    {id:4,name:'Test 4',label:'SPA Aggregate',cite:'§1.469-5T(a)(4)',desc:'Activity is a Significant Participation Activity (>100 hrs in a trade or business in which you do not otherwise materially participate) and all your SPAs aggregate to more than 500 hours for the year. SPAs are non-rental trade-or-business activities only; LTR rental activities cannot generate SPAs.',auto:false,met:!!mn[4]},
    {id:5,name:'Test 5',label:'5 of Last 10 Yrs',cite:'§1.469-5T(a)(5)',desc:'Materially participated in this activity in any 5 of the last 10 taxable years.',auto:false,met:!!mn[5]},
    {id:6,name:'Test 6',label:'3 Prior Yrs (Personal Service Activity)',cite:'§1.469-5T(a)(6)',desc:'Materially participated 3 prior years when the activity was a personal service activity. Does not apply to most STRs — STR properties are almost never personal service activities (medical, law, engineering, etc.).',auto:false,met:!!mn[6]},
    {id:7,name:'Test 7',label:'Facts & Circumstances',cite:'§1.469-5T(a)(7)',desc:'Participate on a regular, continuous, and substantial basis. Requires more than 100 hours of participation (§1.469-5T(b)(2)(iii)). Does NOT apply if any other person is compensated for managing the activity, or if any other individual performs more management hours than you (§1.469-5T(b)(2)(ii)). Document frequency, duration, and nature of involvement.',auto:true,met:ownerEff>TAX.MP_TEST7_MIN&&ownerEff>=mo&&!paidManager},
  ];
}

// AUDIT FIX (Critical #4): Average-rental-period gate, Reg. §1.469-1T(e)(3)(ii).
// An STR escapes "rental activity" treatment (so material participation can make losses
// non-passive) ONLY if (A) the average period of customer use is ≤7 days, OR (B) it is
// ≤30 days AND significant personal services are provided. Material participation is
// necessary but NOT sufficient. We do not yet capture "significant personal services",
// so the 8–30-day band is reported as CONDITIONAL rather than auto-qualifying, and
// >30-day / unset properties do not qualify on material participation alone.
function strGate(p){
  const d=(p&&p.avgRentalDays!=null&&p.avgRentalDays!=='')?Number(p.avgRentalDays):null;
  if(d==null||isNaN(d))return'unknown';        // average not set yet
  if(d<=TAX.STR_AVG_DAYS)return'exempt';        // ≤7   → §(ii)(A): not a rental activity
  if(d<=TAX.STR_MID_DAYS)return'services';      // 8–30 → §(ii)(B): needs significant personal services
  return'rental';                               // >30  → standard rental rules (needs REPS)
}
// 'yes'         → non-passive: period exception met AND materially participates
// 'conditional' → 8–30-day band + MP met, pending significant-services confirmation
// 'no'          → MP not met, or period gate fails (>30 days / not set)
function strQualifies(p){
  if(!mpT(p.id).some(t=>t.met))return'no';
  const g=strGate(p);
  if(g==='exempt')return'yes';
  if(g==='services')return'conditional';
  return'no';
}

function renderNav(){
  document.getElementById('sb-nav').innerHTML=NAV.map(n=>{
    if(n.id==='divider')return`<div role="separator" style="height:.5px;background:#1E3A5F;margin:8px 10px;"></div>`;
    const isActive=view===n.id;
    return`<div class="ni${isActive?' active':''}" role="menuitem" tabindex="0" aria-current="${isActive?'page':'false'}" aria-label="${n.label}" data-act="nav" data-target="${n.id}" data-kd="activate"><span class="ni-ic" aria-hidden="true">${n.ic}</span>${n.label}</div>`;
  }).join('');
}
function updateSB(){
  const r=calcREPS(),pct=Math.min(r.rh/750*100,100);
  document.getElementById('sb-val').textContent=r.ok?'✓ Qualified!':`${Math.round(r.rh)} / >750 hrs`;
  document.getElementById('sb-val').style.color=r.ok?'#14B8A6':'#fff';
  document.getElementById('sb-fill').style.width=pct+'%';
  document.getElementById('sb-fill').style.background=r.ok?'#10B981':'#14B8A6';
  const strHrs=yearEntries().filter(e=>!e.isSpouse&&e.trackType==='STR').reduce((s,e)=>s+(e.hours||0),0);
  const strPs=state.properties.filter(p=>p.type==='STR');
  const strQ=strPs.map(p=>strQualifies(p));
  const strQual=strQ.filter(v=>v==='yes').length;
  const strEl=document.getElementById('sb-str-val');
  const strPropsEl=document.getElementById('sb-str-props');
  if(strEl)strEl.textContent=strPs.length?`${Math.round(strHrs)} hrs · ${strQual}/${strPs.length} qualifying`:`${Math.round(strHrs)} hrs logged`;
  if(strEl)strEl.style.color=strPs.length&&strQual===strPs.length&&strPs.length>0?'#14B8A6':'#fff';
  if(strPropsEl)strPropsEl.innerHTML=strPs.map(p=>{
    const q=strQualifies(p);
    const ic=q==='yes'?'✓':q==='conditional'?'⚠':'';
    const bg=q==='yes'?'#14B8A622':q==='conditional'?'#F59E0B22':'#1E4A6E';
    const fg=q==='yes'?'#14B8A6':q==='conditional'?'#FBBF24':'#7DD3FC';
    return`<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:99px;background:${bg};color:${fg};white-space:nowrap;">${ic} ${esc(p.name.length>10?p.name.slice(0,10)+'…':p.name)}</span>`;
  }).join('');
}
function go(v){view=v;if(chartInst){chartInst.destroy();chartInst=null;}renderNav();updateSB();renderView();}

function svgRing(val,max,color,bg,sz=110,sw=10){
  const r=(sz-sw)/2,c=2*Math.PI*r,off=c*(1-Math.min(val/max,1));
  return`<svg width="${sz}" height="${sz}" style="transform:rotate(-90deg);display:block;"><circle cx="${sz/2}" cy="${sz/2}" r="${r}" fill="none" stroke="${bg}" stroke-width="${sw}"/><circle cx="${sz/2}" cy="${sz/2}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round"/></svg>`;
}

// ── DASHBOARD ──
function vDashboard(){
  const r=calcREPS(),{rh,pct,m750,m50,ok}=r;
  const tot=rh+(state.settings.nonREPSHours||0);
  const strPs=state.properties.filter(p=>p.type==='STR');
  const ltrPs=state.properties.filter(p=>p.type==='LTR');
  const repsHrs=rh;
  const propIds=new Set(state.properties.map(p=>p.id));
  const strHrs=yearEntries().filter(e=>!e.isSpouse&&e.trackType==='STR'&&propIds.has(e.propertyId)).reduce((s,e)=>s+(e.hours||0),0);
  const _strQ=strPs.map(p=>strQualifies(p));
  const strQual=_strQ.filter(v=>v==='yes').length;
  const strTotal=strPs.length;
  const grouped=state.settings.groupingElection;
  const _50incomplete=(state.settings.nonREPSHours||0)===0&&repsHrs>0;

  // ── Strategy detection ──
  const hasLTR=ltrPs.length>0;
  const hasSTR=strPs.length>0;
  const hasNeither=!hasLTR&&!hasSTR;
  const hasBoth=hasLTR&&hasSTR;

  // ── Helpers ──
  function bar(val,max,color){
    const w=Math.min(100,(val/max)*100);
    return'<div style="height:8px;background:#E2E8F0;border-radius:99px;overflow:hidden;margin:8px 0 4px;"><div style="height:100%;width:'+w+'%;background:'+color+';border-radius:99px;transition:width .4s;"></div></div>';
  }
  function badge(met,yes,no){
    return'<span style="background:'+(met?'#ECFDF5':'#FEE2E2')+';color:'+(met?'#065F46':'#991B1B')+';font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap;">'+(met?yes:no)+'</span>';
  }
  function sectionLabel(txt,sub){
    return'<div style="margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #F1F5F9;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;">'+txt+'</div>'+(sub?'<div style="font-size:11px;color:#CBD5E1;font-family:ui-monospace,monospace;margin-top:2px;">'+sub+'</div>':'')+'</div>';
  }

  const _showSettBanner=!localStorage.getItem('rr_settings_banner')&&(state.settings.nonREPSHours||0)===0;
  const settingsBanner=_showSettBanner?
    '<div id="set-banner" style="background:#FFF7ED;border:1px solid #FDE68A;border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:flex-start;gap:12px;justify-content:space-between;">'+
      '<div style="font-size:13px;color:#92400E;flex:1;line-height:1.6;"><strong>Have a W-2 job or other non-real-estate income?</strong> Enter your hours in Settings so the 50% Services Test calculates correctly. Without it, your REPS status could show as qualified when it isn\'t.</div>'+
      '<div style="display:flex;gap:8px;flex-shrink:0;margin-top:2px;">'+
        '<button data-act="nav" data-target="settings" style="background:#F59E0B;color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit;">Go to Settings</button>'+
        '<button data-act="dismissSettingsBanner" style="background:#FEF3C7;color:#92400E;border:1px solid #FDE68A;padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;">Dismiss</button>'+
      '</div>'+
    '</div>':'';

  const pageHeader='<div class="ph"><div class="ph-row"><div><h1 class="pg-title">'+activeYear+' Dashboard</h1><div class="pg-sub">Your tax year status at a glance</div></div><div style="display:flex;gap:8px;" class="top-acts"><button class="btn btn-outline btn-sm" data-act="nav" data-target="reports">📋 Audit Report</button><button class="btn btn-teal btn-sm" data-act="nav" data-target="log">+ Log Time</button></div></div></div>';

  // ── No properties: clean onboarding ──
  if(hasNeither){
    return settingsBanner+pageHeader+
    '<div style="margin-bottom:24px;background:#F0FDFA;border:1px solid #CCFBF1;border-radius:14px;padding:24px 28px;">'+
      '<div style="font-size:16px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">👋 Welcome to RepsRecord</div>'+
      '<div style="font-size:13px;color:#64748B;margin-bottom:20px;line-height:1.6;">Start by adding your rental properties. The type you add determines which tax strategy we track.</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+
        '<div style="background:#fff;border-radius:12px;padding:20px;border:1.5px solid #CCFBF1;cursor:pointer;" class="hov-blue" data-act="nav" data-target="properties">'+
          '<div style="font-size:22px;margin-bottom:10px;">🏡</div>'+
          '<div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:4px;">Long-Term Rentals</div>'+
          '<div style="font-size:12px;color:#64748B;line-height:1.6;margin-bottom:14px;">Track hours toward Real Estate Professional Status (REPS). Make rental losses non-passive to offset your W-2 or business income.</div>'+
          '<div style="display:inline-block;background:#38BDF8;color:#fff;font-size:12px;font-weight:700;padding:7px 16px;border-radius:8px;">+ Add LTR Property</div>'+
        '</div>'+
        '<div style="background:#fff;border-radius:12px;padding:20px;border:1.5px solid #CCFBF1;cursor:pointer;" class="hov-teal" data-act="nav" data-target="properties">'+
          '<div style="font-size:22px;margin-bottom:10px;">🏖</div>'+
          '<div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:4px;">Short-Term Rentals</div>'+
          '<div style="font-size:12px;color:#64748B;line-height:1.6;margin-bottom:14px;">Track material participation tests for Airbnb, VRBO, and similar properties. No REPS required — this strategy is available to any investor.</div>'+
          '<div style="display:inline-block;background:#14B8A6;color:#fff;font-size:12px;font-weight:700;padding:7px 16px;border-radius:8px;">+ Add STR Property</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }

  // ── REPS section — shown for LTR users; compact callout for STR-only ──
  let repsSection='';
  if(hasLTR){
    // Full REPS section with LTR property breakdown folded in
    const ltrMpMet=ltrPs.filter(p=>mpT(p.id).some(t=>t.met)).length;
    const ltrInlineRow=ltrPs.length>0&&!grouped?
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px;padding-top:14px;border-top:.5px solid #F0FDFA;">'+
        '<div style="text-align:center;"><div style="font-size:22px;font-weight:900;color:#0D1F3C;">'+ltrPs.length+'</div><div style="font-size:11px;color:#64748B;margin-top:2px;">LTR Properties</div></div>'+
        '<div style="text-align:center;"><div style="font-size:22px;font-weight:900;color:'+( ltrMpMet===ltrPs.length?'#10B981':'#F59E0B')+';">'+ltrMpMet+' / '+ltrPs.length+'</div><div style="font-size:11px;color:#64748B;margin-top:2px;">With MP Met</div><div style="font-size:10px;color:#94A3B8;margin-top:1px;">per-property test</div></div>'+
        '<div style="text-align:center;"><a href="#" data-act="nav" data-target="mp" data-prevent="1" style="font-size:11px;color:#0F766E;font-weight:700;text-decoration:none;display:block;margin-top:4px;">MP Tests →</a><div style="font-size:10px;color:#94A3B8;margin-top:2px;">view detail</div></div>'+
      '</div>':
      (grouped?'<div style="margin-top:12px;font-size:12px;color:#1D4ED8;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:8px 12px;">📋 <strong>Grouping election on file</strong> — all LTR properties combined for MP testing.</div>':'');

    repsSection=
      '<div style="margin-bottom:32px;">'+
      sectionLabel('Real Estate Professional Status (REPS)','IRC §469(c)(7)')+
      '<div style="background:'+(ok?'#ECFDF5':'#F0FDFA')+';border:1.5px solid '+(ok?'#6EE7B7':'#CCFBF1')+';border-radius:14px;padding:16px 20px;margin-bottom:18px;display:flex;align-items:center;gap:14px;">'+
        '<div style="font-size:30px;">'+(ok?'🏆':'⏳')+'</div>'+
        '<div>'+
          '<div style="font-size:15px;font-weight:800;color:#0D1F3C;">'+(ok?'You qualify for Real Estate Professional Status — '+activeYear:'Not yet qualified — both tests must be met')+'</div>'+
          '<div style="font-size:12px;color:#64748B;margin-top:2px;">'+(ok?'Both tests met. Your LTR losses can offset your other income.':'Log qualifying hours and verify your non-RE hours in Settings.')+'</div>'+
        '</div>'+
      '</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+
        // 750-hour card
        '<div class="card" style="padding:20px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">'+
            '<div style="display:flex;align-items:center;gap:10px;">'+
            svgRing(repsHrs,750,m750?'#10B981':'#14B8A6','#E2E8F0',52,6)+
            '<div style="font-size:12px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.05em;">750-Hour Test</div>'+
            '</div>'+
            (m750?badge(true,'✓ MET',''):(repsHrs===0?'<span style="background:#F1F5F9;color:#64748B;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap;">NOT STARTED</span>':'<span style="background:#FEF3C7;color:#92400E;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap;">IN PROGRESS</span>'))+
          '</div>'+
          '<div style="font-size:11px;color:#94A3B8;margin-bottom:8px;">Must exceed 750 hrs in qualifying real estate activities</div>'+
          '<div style="font-size:30px;font-weight:900;color:#0D1F3C;letter-spacing:-0.03em;">'+Math.round(repsHrs)+'<span style="font-size:13px;font-weight:400;color:#64748B;"> / &gt;750 hrs</span></div>'+
          bar(repsHrs,750,m750?'#10B981':'#14B8A6')+
          '<div style="font-size:12px;font-weight:600;color:'+(m750?'#10B981':'#0F766E')+';">'+(m750?'✓ Exceeded requirement by '+Math.round(repsHrs-750)+' hrs':Math.max(0,Math.ceil(750-repsHrs+0.01))+' hrs remaining to qualify')+'</div>'+
          (()=>{
            // BATCH 2 (Pass 4 #14): Anchor pace on first-logged-entry date (or 30 days ago, whichever is later),
            // not Jan 1. A user who started tracking on May 28 shouldn't be measured against a Jan-1 baseline.
            const now=new Date();
            const yearStart=new Date(activeYear,0,1);
            const yearEnd=new Date(activeYear,11,31);
            // Find earliest entry in active year for REPS-counting entries
            const inc=state.settings.includeSTRinREPS===true;
            const strOK=inc?new Set(state.properties.filter(p=>p.type==='STR'&&strQualifies(p)==='yes').map(p=>p.id)):null;
            const yEntries=yearEntries().filter(e=>!e.isSpouse&&(e.trackType==='REPS'||e.trackType==='LTR'||(inc&&e.trackType==='STR'&&strOK&&strOK.has(e.propertyId))));
            let earliest=null;
            yEntries.forEach(e=>{const d=new Date(e.date);if(!earliest||d<earliest)earliest=d;});
            // Anchor: the LATER of (earliest entry date) and (year start). Floor of 30 days back if too recent.
            let anchor=earliest||yearStart;
            if(anchor<yearStart)anchor=yearStart;
            const thirtyDaysAgo=new Date(now.getTime()-30*864e5);
            // If user only started tracking recently, use a 30-day window minimum to avoid wildly over-projecting from a single big entry
            if(anchor>thirtyDaysAgo)anchor=thirtyDaysAgo<yearStart?yearStart:thirtyDaysAgo;
            const daysElapsed=Math.max(1,Math.round((now-anchor)/(864e5)));
            const daysRemaining=Math.max(0,Math.round((yearEnd-now)/(864e5)));
            const rate=repsHrs/daysElapsed;
            const proj=Math.round(repsHrs+rate*daysRemaining);
            const onP=proj>750;
            return repsHrs>0&&!m750?`<div style="font-size:11px;color:${onP?'#0E7490':'#92400E'};margin-top:6px;padding:6px 10px;background:${onP?'#CFFAFE':'#FEF3C7'};border-radius:6px;">📈 At current pace: <strong>${proj} hrs</strong> projected by Dec 31 — ${onP?'✓ on track':'⚠ not on pace'}</div>`:'';
          })() +
          ltrInlineRow+
        '</div>'+
        // 50% card
        '<div class="card" style="padding:20px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">'+
            '<div style="display:flex;align-items:center;gap:10px;">'+
            svgRing(pct,100,(_50incomplete?'#F59E0B':m50?'#10B981':'#EF4444'),'#E2E8F0',52,6)+
            '<div style="font-size:12px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.05em;">50% Services Test</div>'+
            '</div>'+
            (tot===0?'<span style="background:#F1F5F9;color:#64748B;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap;">NOT STARTED</span>':(_50incomplete&&m50?'<span style="background:#FEF3C7;color:#92400E;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap;">⚠ UNVERIFIED</span>':badge(m50,'✓ MET','NOT MET')))+
          '</div>'+
          '<div style="font-size:11px;color:#94A3B8;margin-bottom:8px;">RE hours must exceed 50% of all your personal service hours</div>'+
          '<div style="font-size:30px;font-weight:900;color:#0D1F3C;letter-spacing:-0.03em;">'+Math.round(pct)+'%<span style="font-size:13px;font-weight:400;color:#64748B;"> of work hrs</span></div>'+
          bar(pct,100,_50incomplete?'#F59E0B':m50?'#10B981':'#EF4444')+
          '<div style="font-size:12px;color:#64748B;">'+Math.round(repsHrs)+' RE hrs · '+Math.round(tot)+' total hrs this year</div>'+
          ((state.settings.nonREPSHours||0)===0&&repsHrs>0?'<div style="font-size:11px;margin-top:6px;padding:5px 8px;background:#FFF7ED;border-radius:6px;border:.5px solid #FDE68A;color:#92400E;">⚠ Non-RE hours not entered — result unverified. <a href="#" data-act="nav" data-target="settings" data-prevent="1" style="color:#B45309;font-weight:600;text-decoration:underline;">→ Add in Settings</a></div>':(tot===0?'<div style="font-size:11px;margin-top:6px;"><a href="#" data-act="nav" data-target="settings" data-prevent="1" style="color:#14B8A6;font-weight:600;">→ Enter non-RE hours in Settings to verify this test</a></div>':''))+
        '</div>'+
      '</div>'+
      (!ok&&state.properties.length>0?'<div style="background:#FFF7ED;border:1px solid #FDE68A;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400E;margin-top:14px;">💡 '+(!m750?'Log '+Math.max(0,Math.ceil(750-repsHrs+0.01))+' more qualifying hours to exceed the 750-hr threshold. ':'')+(m750&&!m50?'Your RE hours need to exceed 50% of all hours. Add your non-RE hours in Settings.':'')+'</div>':'')+
      // BATCH 2 (Pass 4 #11): Per-property MP gating — REPS qualification requires per-property
      // material participation OR a §469(c)(7)(A) grouping election. Surface a banner if both
      // REPS tests pass but per-property MP doesn't on some LTR.
      ((ok&&hasLTR&&!grouped)?(function(){
        const ltrUnmet=ltrPs.filter(lp=>!mpT(lp.id).some(t=>t.met));
        if(ltrUnmet.length===0)return'';
        return'<div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:10px;padding:12px 14px;font-size:12px;color:#92400E;line-height:1.6;margin-top:14px;">⚠ <strong>Per-property MP not verified for '+ltrUnmet.length+' of '+ltrPs.length+' LTR'+(ltrPs.length>1?' properties':' property')+'.</strong> REPS qualification alone does not make rental losses non-passive — you must also materially participate in each rental activity (or file a §469(c)(7)(A) grouping election). <a href="#" data-act="nav" data-target="mp" data-prevent="1" style="color:#92400E;font-weight:700;text-decoration:underline;">Review MP tests →</a></div>';
      })():'')+
    '</div>';
  } else {
    // STR-only: compact REPS callout
    repsSection=
      '<div style="margin-bottom:24px;background:#F0FDFA;border:.5px solid #CCFBF1;border-radius:12px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">'+
        '<div>'+
          '<div style="font-size:13px;font-weight:700;color:#0D1F3C;margin-bottom:3px;">Real Estate Professional Status (REPS)</div>'+
          '<div style="font-size:12px;color:#64748B;line-height:1.5;">Your STR strategy doesn\'t require REPS. If you add long-term rentals, REPS can make those losses non-passive too.</div>'+
        '</div>'+
        '<div style="display:flex;gap:8px;flex-shrink:0;">'+
          '<a href="#" data-act="nav" data-target="ltr" data-prevent="1" style="font-size:12px;color:#0E7490;font-weight:600;text-decoration:none;white-space:nowrap;">What is REPS? →</a>'+
        '</div>'+
      '</div>';
  }

  // ── Strategy bridge (only when both) ──
  const strategyBridge=hasBoth?
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;padding:10px 16px;background:#F8FAFC;border:.5px solid #E2E8F0;border-radius:10px;">'+
      '<div style="font-size:16px;">🔀</div>'+
      '<div style="font-size:12px;color:#64748B;line-height:1.5;">You\'re tracking two strategies. <strong>REPS</strong> (above) covers your long-term rentals under IRC §469(c)(7). <strong>STR Material Participation</strong> (below) is a separate test for each short-term rental under Temp. Reg. §1.469-5T.</div>'+
    '</div>':'';

  // ── STR section ──
  const strStatusOk=strTotal>0&&strQual===strTotal;
  // AUDIT FIX (Critical #4): surface properties that materially participate but fail the
  // average-rental-period gate (8–30 days needs significant services; >30 / unset = not exempt).
  const _condProps=strPs.filter(p=>strQualifies(p)==='conditional');
  const _failGate=strPs.filter(p=>strQualifies(p)==='no'&&mpT(p.id).some(t=>t.met));
  const strGateNote=(_condProps.length||_failGate.length)?
    '<div style="background:#FFF7ED;border:1px solid #FDE68A;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400E;line-height:1.6;margin-bottom:14px;">'+
      (_condProps.length?'<div>⚠ <strong>'+_condProps.length+' '+(_condProps.length===1?'property':'properties')+'</strong> with an 8–30 day average '+(_condProps.length===1?'meets':'meet')+' material participation but '+(_condProps.length===1?'qualifies':'qualify')+' <strong>only if significant personal services are provided</strong> (Reg. §1.469-1T(e)(3)(ii)(B)). Not counted as qualifying until confirmed with your tax professional.</div>':'')+
      (_failGate.length?'<div'+(_condProps.length?' style="margin-top:6px;"':'')+'>⚠ <strong>'+_failGate.length+' '+(_failGate.length===1?'property':'properties')+'</strong> materially '+(_failGate.length===1?'participates':'participate')+' but the average rental period is over 30 days (or not set), so the STR exception does not apply — these need REPS for non-passive treatment.</div>':'')+
    '</div>':'';
  const strSection=hasSTR?
    '<div style="margin-bottom:32px;">'+
    sectionLabel('Short-Term Rental Strategy','Reg. §1.469-1T(e)(3)(ii) period test + Temp. Reg. §1.469-5T material participation')+
    '<div style="background:'+(strStatusOk?'#ECFDF5':strTotal>0?'#FFF7ED':'#F0FDFA')+';border:1.5px solid '+(strStatusOk?'#6EE7B7':strTotal>0?'#FDE68A':'#CCFBF1')+';border-radius:14px;padding:16px 20px;margin-bottom:18px;display:flex;align-items:center;gap:14px;">'+
      '<div style="font-size:30px;">'+(strStatusOk?'🏆':'⏳')+'</div>'+
      '<div>'+
        '<div style="font-size:15px;font-weight:800;color:#0D1F3C;">'+(strStatusOk?'All STR properties qualify for non-passive treatment — '+activeYear:strQual+' of '+strTotal+' STR '+(strTotal===1?'property qualifies':'properties qualify')+' — keep logging hours')+'</div>'+
        '<div style="font-size:12px;color:#64748B;margin-top:3px;">A property qualifies when its average rental period is ≤7 days <strong>and</strong> you pass any 1 of 7 material participation tests. Then losses are non-passive without needing REPS.</div>'+
      '</div>'+
    '</div>'+
    strGateNote+
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">'+
      '<div class="card" style="text-align:center;padding:16px 12px;"><div style="font-size:28px;font-weight:900;color:#38BDF8;">'+Math.round(strHrs)+'</div><div style="font-size:12px;font-weight:600;color:#64748B;margin-top:2px;">STR Hours Logged</div></div>'+
      '<div class="card" style="text-align:center;padding:16px 12px;"><div style="font-size:28px;font-weight:900;color:#10B981;">'+strQual+' / '+strTotal+'</div><div style="font-size:12px;font-weight:600;color:#64748B;margin-top:2px;">Properties Qualifying</div></div>'+
      '<div class="card" style="text-align:center;padding:16px 12px;"><div style="font-size:28px;font-weight:900;color:'+(strTotal-strQual>0?'#EF4444':'#10B981')+';">'+(strTotal-strQual)+'</div><div style="font-size:12px;font-weight:600;color:#64748B;margin-top:2px;">Not Yet Qualifying</div></div>'+
    '</div>'+
    '<div style="text-align:right;"><a href="#" data-act="nav" data-target="mp" data-prevent="1" style="font-size:12px;color:#0F766E;font-weight:700;text-decoration:none;">View per-property MP tests →</a></div>'+
  '</div>':'';

  // ── Chart section ──
  const _hasEntries=state.entries.filter(e=>e.date&&e.date.startsWith(String(activeYear))).length>0;
  const chartSection=_hasEntries?`
<div style="margin-bottom:32px;">
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94A3B8;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #F1F5F9;">Hours Trend</div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
      <div style="font-size:13px;font-weight:700;color:#0D1F3C;">${activeYear} Activity</div>
      <div style="display:flex;background:#F0FDFA;border-radius:8px;padding:3px;gap:2px;">
        <button data-act="chartTab" data-tab="monthly" style="padding:5px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;background:${_chartTab==='monthly'?'#14B8A6':'transparent'};color:${_chartTab==='monthly'?'#fff':'#64748B'};">Monthly</button>
        <button data-act="chartTab" data-tab="property" style="padding:5px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;background:${_chartTab==='property'?'#14B8A6':'transparent'};color:${_chartTab==='property'?'#fff':'#64748B'};">By Property</button>
      </div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#64748B;"><span style="width:12px;height:12px;border-radius:3px;background:#14B8A6;display:inline-block;"></span>REPS</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#64748B;"><span style="width:12px;height:12px;border-radius:3px;background:#38BDF8;display:inline-block;"></span>STR</div>
    </div>
    <div class="chart-wrap" style="height:${_chartTab==='property'?Math.max(140,state.properties.length*52)+'px':'200px'};">
      <canvas id="mc" aria-label="${_chartTab==='monthly'?'Monthly hours bar chart for '+activeYear:'Hours by property bar chart'}" role="img"></canvas>
    </div>
  </div>
</div>`:'';

  return settingsBanner+pageHeader+repsSection+strategyBridge+strSection+chartSection;
}


// ── LOG TIME ──
function vLog(){
  const cats=trackType==='STR'?STR_CATS:REPS_CATS;
  const all=[...yearEntries()].sort((a,b)=>new Date(b.date)-new Date(a.date));
  return`
<div class="ph" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
  <div><h1 class="pg-title">Log Time</h1><div class="pg-sub">Record qualifying hours for REPS (IRC §469(c)(7)) and STR material participation (Temp. Reg. §1.469-5T)</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button data-act="dupePrevDay" title="Copy all of the previous logged day's entries to today" style="background:#F0FDFA;border:1px solid #CCFBF1;color:#0E7490;font-size:13px;font-weight:700;padding:10px 16px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;font-family:inherit;">📋 Duplicate previous day</button>
    <button data-act="exportTimeLog" title="Download the current time-log view as Excel" style="background:#ECFDF5;border:1px solid #6EE7B7;color:#065F46;font-size:13px;font-weight:700;padding:10px 16px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;font-family:inherit;">⬇ Export Time Log</button>
    <button data-act="showImportModal" style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1D4ED8;font-size:13px;font-weight:700;padding:10px 18px;border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;font-family:inherit;">📊 Import from Excel</button>
  </div>
</div>

<!-- Import Modal -->
<div id="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:none;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:16px;padding:32px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.3);">
    <div id="import-modal-title" style="font-size:20px;font-weight:900;color:#0D1F3C;margin-bottom:6px;">📊 Import Hours from Excel</div>
    <p style="font-size:13px;color:#64748B;margin-bottom:20px;line-height:1.6;">Upload an Excel (.xlsx) or CSV file. Your file must have these column headers (exact spelling):</p>
    <div style="background:#F0FDFA;border:1px solid #CCFBF1;border-radius:10px;padding:14px 16px;margin-bottom:12px;font-size:12px;font-family:ui-monospace,monospace;color:#0E7490;line-height:2;">
      <strong>date</strong> &nbsp;|&nbsp; <strong>hours</strong> &nbsp;|&nbsp; <strong>minutes</strong> &nbsp;|&nbsp; <strong>property</strong> &nbsp;|&nbsp; <strong>type</strong> &nbsp;|&nbsp; <strong>category</strong> &nbsp;|&nbsp; <strong>notes</strong>
    </div>
    <div style="margin-bottom:16px;"><button data-act="downloadImportTemplate" style="background:#ECFDF5;border:1px solid #6EE7B7;color:#065F46;font-size:12px;font-weight:700;padding:8px 14px;border-radius:8px;cursor:pointer;font-family:inherit;">⬇ Download Template (.csv)</button></div>
    <div style="font-size:12px;color:#64748B;margin-bottom:16px;line-height:1.7;">
      <strong>date</strong> — format: YYYY-MM-DD (e.g. 2026-01-15)<br>
      <strong>hours</strong> — whole number (e.g. 2)<br>
      <strong>minutes</strong> — 0, 15, 30, or 45<br>
      <strong>property</strong> — must match an existing property name exactly<br>
      <strong>type</strong> — REPS or STR<br>
      <strong>category</strong> — any activity category<br>
      <strong>notes</strong> — optional description
    </div>
    <div id="import-drop" class="hov-drop" data-act="triggerClick" data-target-id="import-file" style="border:2px dashed #CBD5E1;border-radius:12px;padding:32px;text-align:center;cursor:pointer;background:#F8FAFC;margin-bottom:16px;transition:all .15s;">
      <div style="font-size:28px;margin-bottom:8px;">📂</div>
      <div style="font-size:14px;font-weight:700;color:#0D1F3C;">Click to choose your file</div>
      <div style="font-size:12px;color:#94A3B8;margin-top:4px;">.xlsx or .csv files supported</div>
      <input type="file" id="import-file" accept=".xlsx,.csv" style="display:none" data-chg="importFile"/>
    </div>
    <div id="import-status" style="display:none;margin-bottom:16px;"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button data-act="closeImportModal" style="background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0;padding:10px 20px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;">Cancel</button>
      <button id="import-confirm-btn" data-act="confirmImport" style="display:none;background:#14B8A6;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Import Entries</button>
    </div>
  </div>
</div>
<div class="card card-mb">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
    <div class="track-bar" style="flex:1;min-width:260px;margin-bottom:0;">
      <button class="track-btn${trackType==='REPS'?' active-reps':''}" data-act="setTT" data-arg="REPS">🏡 REPS Hours (RE Activities)</button>
      <button class="track-btn${trackType==='STR'?' active-str':''}" data-act="setTT" data-arg="STR">🏖 STR Hours (MP)</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
      ${timerStart?`<span id="timer-display" style="font-size:18px;font-weight:900;color:#EF4444;font-family:ui-monospace,monospace;letter-spacing:.05em;"></span>`:''}
      <button id="timer-btn" data-act="toggleTimer" style="padding:9px 14px;border-radius:8px;border:1px solid ${timerStart?'#EF4444':'#CCFBF1'};background:${timerStart?'#EF4444':'#fff'};color:${timerStart?'#fff':'#0D1F3C'};font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">${timerStart?'⏹ Stop & Fill':'⏱ Start Timer'}</button>
    </div>
  </div>
  <div class="info-box ${trackType==='STR'?'ib-blue':'ib-teal'}">
    ${trackType==='REPS'?'<strong>Qualifying activities</strong> include property management, acquisition, construction, leasing, maintenance, brokerage, and related financial/legal work (IRC §469(c)(7)(C)). General RE hours also cover any real property trade or business — not just rentals.':'<strong>STR hours</strong> count toward material participation for properties with avg rental period ≤7 days (Reg. §1.469-1T(e)(3)(ii)(A)).'}
  </div>
  <div class="g2">
    <div class="field"><label class="fl">Date</label><input type="date" id="f-date" value="${todayStr()}" max="${todayStr()}"/></div>
    <div class="field"><label class="fl">Property ${trackType==='STR'?'<span style="color:#EF4444;">*</span>':''}</label>
      <select id="f-prop">${(()=>{
        if(trackType==='STR'){
          const sp=state.properties.filter(p=>p.type==='STR');
          return '<option value="" disabled selected>— Select an STR property —</option>'+
            (sp.length?sp.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join(''):'<option value="" disabled>No STR properties yet</option>');
        } else {
          const lp=state.properties.filter(p=>p.type==='LTR');
          return '<option value="">— General RE (not property-specific) —</option>'+
            lp.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
        }
      })()}</select>
      ${trackType==='STR'&&!state.properties.some(p=>p.type==='STR')?'<div class="hint" style="color:#F59E0B;margin-top:4px;">No STR properties yet. <a href="#" data-act="nav" data-target="properties" data-prevent="1" style="color:#14B8A6;font-weight:600;">Add one in Properties →</a></div>':''}
      ${trackType==='REPS'&&!state.properties.some(p=>p.type==='LTR')?'<div class="hint" style="margin-top:4px;">No LTR properties yet — <a href="#" data-act="nav" data-target="properties" data-prevent="1" style="color:#14B8A6;font-weight:600;">add one in Properties →</a> or select general above.</div>':''}
    </div>
  </div>
  <div class="field"><label class="fl">Activity Category</label>
    <select id="f-cat"><option value="">Select qualifying activity...</option>${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
    <div class="hint" id="cat-hint" style="margin-top:4px;">${trackType==='STR'?'<strong>Material Participation Hours</strong> = active hands-on management of this STR property. Choose a specific category below for better audit documentation.':'<strong>General REPS Hours</strong> = any qualifying real estate professional activity. Choose a specific category below for stronger audit records.'}</div>
  </div>
  <div class="g2">
    <div class="field"><label class="fl">Hours</label><input type="number" id="f-hrs" min="0" max="24" step="1" placeholder="0"/></div>
    <div class="field"><label class="fl">Minutes</label>
      <select id="f-mins"><option value="0">0 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option></select>
    </div>
  </div>
  <div class="field"><label class="fl">Notes / Description <span style="font-weight:400;text-transform:none;color:#94A3B8;">— recommended for audit substantiation</span></label>
    <textarea id="f-notes" placeholder="Describe the activity, who you contacted, decisions made, outcome..."></textarea>
  </div>
  <div class="field">
    <label class="fl">Evidence / Attachments <span style="font-weight:400;text-transform:none;color:#94A3B8;">— receipts, photos, invoices, contracts</span></label>
    <div class="upload-zone" data-act="triggerClick" data-target-id="f-files">
      <input type="file" id="f-files" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" data-chg="previewFiles"/>
      <div class="upload-zone-label">📎 Click to attach files — images, PDFs, docs</div>
      <div id="f-file-preview" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;justify-content:center;"></div>
    </div>
  </div>
  ${state.settings.spouseEnabled?`<label class="tog-row"><input type="checkbox" id="f-spouse"/><span class="tog-lbl">Log as ${state.settings.spouseName||'Spouse'}'s hours (tracked separately)</span></label>`:''}
  <button class="btn btn-block" id="sub-btn" data-act="submitEntry" style="background:${trackType==='STR'?'#38BDF8':'#14B8A6'};color:#fff;">+ Log ${trackType} Entry</button>
</div>
${all.length?`
<!-- Filter bar --><div role="search" aria-label="Filter and search entries">
<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
  <div style="display:flex;background:#F0FDFA;border-radius:8px;padding:3px;gap:2px;">
    ${['all','REPS','STR'].map(t=>`<button data-act="logFilterType" data-arg="${t}" style="padding:5px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;background:${logFilter.type===t?(t==='STR'?'#38BDF8':'#14B8A6'):'transparent'};color:${logFilter.type===t?'#fff':'#64748B'};">${t==='all'?'All':t}</button>`).join('')}
  </div>
  <select data-chg="logFilterProp" style="padding:6px 10px;border-radius:8px;border:1px solid #CBD5E1;font-size:12px;font-family:inherit;color:#0D1F3C;background:#fff;cursor:pointer;">
    <option value="">All properties</option>
    ${state.properties.map(p=>`<option value="${p.id}" ${logFilter.propId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
  </select>
  <input value="${logFilter.search}" data-inp="logFilterSearch" placeholder="Search notes…" style="flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid #CBD5E1;font-size:12px;font-family:inherit;"/>
  <div id="bulk-bar" style="display:${selEntries.size>0?'flex':'none'};gap:8px;align-items:center;">
    <button id="bulk-cnt" data-act="bulkDelete" style="background:#EF4444;color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Delete selected (${selEntries.size})</button>
  </div>
</div></div>
${(()=>{
  let filtered=[...all];
  if(logFilter.type!=='all')filtered=filtered.filter(e=>e.trackType===logFilter.type);
  if(logFilter.propId)filtered=filtered.filter(e=>e.propertyId===logFilter.propId);
  if(logFilter.search){const q=logFilter.search.toLowerCase();filtered=filtered.filter(e=>(e.notes||'').toLowerCase().includes(q)||(e.category||'').toLowerCase().includes(q));}
  if(!filtered.length)return`<div style="text-align:center;padding:32px;color:#94A3B8;font-size:13px;background:#F8FAFC;border-radius:10px;border:.5px solid #E2E8F0;">No entries match your filter — <a href="#" data-act="clearLogFilter" data-prevent="1" style="color:#14B8A6;font-weight:600;">clear filters</a></div>`;
  return`<h2 class="sec-lbl" style="margin-bottom:8px;">Entries (${filtered.length}${filtered.length<all.length?' of '+all.length:''})<label style="float:right;font-size:10px;font-weight:700;color:#64748B;cursor:pointer;display:flex;align-items:center;gap:5px;"><input type="checkbox" class="entry-cb-all" data-chg="selectAll" style="accent-color:#14B8A6;"/> Select all</label></h2>
<div class="card">
${filtered.map(e=>{const pr=state.properties.find(p=>p.id===e.propertyId);const cats=e.trackType==='STR'?STR_CATS:REPS_CATS;const isSel=selEntries.has(e.id);return`
<div class="ei" style="flex-wrap:wrap;${isSel?'background:#F0FDFA;border-radius:8px;':''}">
  <input type="checkbox" class="entry-cb" data-id="${e.id}" ${isSel?'checked':''} data-chg="selEntry" style="accent-color:#14B8A6;width:16px;height:16px;flex-shrink:0;margin-top:11px;"/>
  <div class="ei-ic" style="background:${e.trackType==='STR'?'#E0F7FA':'#F0FDFA'};">${e.trackType==='STR'?'🏖':'🏡'}</div>
  <div style="flex:1;min-width:0;">
    <div class="ei-cat">${esc(e.category)}<span class="tb tb-${e.trackType==='STR'?'s':'r'}">${e.trackType}</span>${e.isSpouse?'<span class="tb tb-sp">SPOUSE</span>':''}${e.attachments&&e.attachments.length?`<span class="attach-badge">📎 ${e.attachments.length}</span>`:''}</div>
    <div class="ei-meta">${e.date} · ${pr?.name||'General RE'} · ${fmtH(e.hours)}</div>
    ${e.notes?`<div class="ei-note">"${esc(e.notes)}"</div>`:''}
    ${e.attachments&&e.attachments.length?`<div class="attach-list">${e.attachments.map(a=>`<span class="attach-chip"><a href="#" data-act="openAtt" data-path="${esc(a.path||'')}" data-url="${esc(a.url||'')}" title="${esc(a.name)}">📄 ${esc(a.name.length>20?a.name.slice(0,20)+'…':a.name)}</a><button data-act="delAttachment" data-id="${e.id}" data-name="${esc(a.name)}" title="Remove">×</button></span>`).join('')}</div>`:''}
  </div>
  <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
    <div class="ei-hrs">${fmtH(e.hours)}</div>
    <button data-act="dupeEntry" data-id="${e.id}" aria-label="Copy ${esc(e.category)} entry to new entry" title="Copy to new entry" style="background:#F0FDFA;border:1px solid #CCFBF1;color:#0E7490;font-size:11px;padding:5px 10px;border-radius:6px;cursor:pointer;font-weight:600;">📋 Copy</button>
    <button data-act="showEditEntry" data-id="${e.id}" aria-label="Edit ${esc(e.category)} entry from ${esc(e.date)}" style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1D4ED8;font-size:11px;padding:5px 10px;border-radius:6px;cursor:pointer;font-weight:600;">✏️ Edit</button>
    <button class="ei-del" data-act="delEntry" data-id="${e.id}" aria-label="Delete ${esc(e.category)} entry from ${esc(e.date)}" title="Delete entry">🗑</button>
  </div>
  <div id="edit-entry-${e.id}" style="display:none;width:100%;margin-top:12px;background:#F8FAFC;border:1.5px solid #CBD5E1;border-radius:10px;padding:14px;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#14B8A6;margin-bottom:12px;">Edit Entry</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px;">
      <div class="field"><label class="fl">Date</label><input type="date" id="ee-date-${e.id}" value="${e.date}" max="${todayStr()}"/></div>
      <div class="field"><label class="fl">Hours</label><input type="number" id="ee-hrs-${e.id}" value="${Math.floor(e.hours)}" min="0" max="24" step="1"/></div>
      <div class="field"><label class="fl">Minutes</label><input type="number" id="ee-min-${e.id}" value="${Math.round((e.hours%1)*60)}" min="0" max="59" step="15"/></div>
    </div>
    <div class="field" style="margin-bottom:10px;"><label class="fl">Category</label>
      <select id="ee-cat-${e.id}">${cats.map(c=>`<option value="${c}" ${c===e.category?'selected':''}>${c}</option>`).join('')}</select>
    </div>
    <div class="field" style="margin-bottom:12px;"><label class="fl">Notes / Description</label>
      <textarea id="ee-note-${e.id}" rows="2" placeholder="Describe what you did...">${esc(e.notes||'')}</textarea>
    </div>
    <div style="display:flex;gap:8px;">
      <button data-act="saveEditEntry" data-id="${e.id}" style="background:#14B8A6;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">Save changes</button>
      <button data-act="hideEditEntry" data-id="${e.id}" style="background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0;padding:9px 14px;border-radius:8px;font-size:13px;cursor:pointer;">Cancel</button>
    </div>
  </div>
</div>`;}).join('')}
</div>`;
})()}
`:`<div class="empty"><div class="empty-ic">⏱</div><div class="empty-tx">No entries yet — log your first hours above.</div></div>`}`;
}

function setTT(t){trackType=t;renderView();}

// ── LIVE TIMER ──
function toggleTimer(){timerStart?stopTimer():startTimer();}
function startTimer(){
  timerStart=Date.now();
  const btn=document.getElementById('timer-btn');
  if(btn){btn.textContent='⏹ Stop & Fill';btn.style.background='#EF4444';btn.style.border='none';}
  const disp=document.getElementById('timer-display');
  if(disp)disp.style.display='flex';
  timerTick=setInterval(()=>{
    const el=document.getElementById('timer-display');
    if(!el||!timerStart)return;
    const tot=Math.floor((Date.now()-timerStart)/1000);
    const h=Math.floor(tot/3600),m=Math.floor((tot%3600)/60),sc=tot%60;
    el.textContent=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  },1000);
}
function stopTimer(){
  if(!timerStart)return;
  clearInterval(timerTick);timerTick=null;
  const mins=Math.floor((Date.now()-timerStart)/60000);
  const hrs=Math.floor(mins/60),m=mins%60;
  timerStart=null;
  renderView();
  setTimeout(()=>{
    const hEl=document.getElementById('f-hrs');
    const mEl=document.getElementById('f-mins');
    if(hEl)hEl.value=hrs;
    if(mEl){const opts=[0,15,30,45];mEl.value=opts.reduce((p,c)=>Math.abs(c-m)<Math.abs(p-m)?c:p);}
    hEl?.focus();
  },50);
}

// ── DUPLICATE ENTRY ──
function dupeEntry(id){
  const e=state.entries.find(x=>x.id===id);if(!e)return;
  trackType=e.trackType==='STR'?'STR':'REPS';
  renderView();
  setTimeout(()=>{
    const set=(elId,val)=>{const el=document.getElementById(elId);if(el)el.value=val;};
    set('f-date',todayStr());
    set('f-prop',e.propertyId||'');
    set('f-cat',e.category||'');
    set('f-hrs',Math.floor(e.hours));
    const m=Math.round((e.hours%1)*60);
    const opts=[0,15,30,45];
    set('f-mins',opts.reduce((p,c)=>Math.abs(c-m)<Math.abs(p-m)?c:p));
    set('f-notes',e.notes||'');
    document.querySelector('.card.card-mb')?.scrollIntoView({behavior:'smooth'});
  },50);
}

// ── ENTRY FILTER ──
function setLogFilter(key,val){logFilter[key]=val;renderView();}

// ── BULK SELECT / DELETE ──
function toggleSelEntry(id,chk){chk?selEntries.add(id):selEntries.delete(id);refreshBulkBar();}
function selectAllEntries(chk){
  document.querySelectorAll('.entry-cb').forEach(b=>{if(!b.dataset.id)return;b.checked=chk;chk?selEntries.add(b.dataset.id):selEntries.delete(b.dataset.id);});
  refreshBulkBar();
}
function refreshBulkBar(){
  const bar=document.getElementById('bulk-bar');
  if(bar)bar.style.display=selEntries.size>0?'flex':'none';
  const cnt=document.getElementById('bulk-cnt');
  if(cnt)cnt.textContent=`Delete selected (${selEntries.size})`;
}
async function bulkDelete(){
  if(!selEntries.size)return;
  const n=selEntries.size;
  const ok=await dlgConfirm({title:'Delete entries',body:`Delete ${n} time ${n===1?'entry':'entries'}? You can undo this right after.`,confirmLabel:'Delete',danger:true});
  if(!ok)return;
  const removed=state.entries.filter(e=>selEntries.has(e.id));
  state.entries=state.entries.filter(e=>!selEntries.has(e.id));
  selEntries=new Set();save();renderView();
  toast(`${removed.length} ${removed.length===1?'entry':'entries'} deleted.`,'info',{duration:6000,action:'Undo',onAction:()=>{state.entries.push(...removed);save();renderView();toast('Restored.','success');}});
}

// ── FILE PREVIEW ──
let pendingFiles=[];
function previewFiles(input){
  pendingFiles=Array.from(input.files);
  const prev=document.getElementById('f-file-preview');
  if(!prev)return;
  prev.innerHTML=pendingFiles.map(f=>`<span style="font-size:11px;padding:2px 8px;background:#CFFAFE;border-radius:99px;color:#0E7490;font-weight:600;">📄 ${f.name.length>20?f.name.slice(0,20)+'…':f.name}</span>`).join('');
  const lbl=document.querySelector('.upload-zone-label');
  if(lbl)lbl.textContent=`📎 ${pendingFiles.length} file${pendingFiles.length>1?'s':''} selected — click to change`;
}

// ── UPLOAD TO SUPABASE STORAGE ──
async function uploadFiles(entryId,files){
  // Pass 8 (private-storage): attachments are written under a per-user path prefix
  //   `${userId}/${entryId}/...` so a Storage RLS policy can scope access to the owner, and the
  // file is served later via a short-lived SIGNED url (see attUrl/openAtt) instead of a public link.
  // Cloud attachments require an authenticated session.
  const attachments=[];
  let failed=0;
  const list=Array.from(files||[]);
  if(list.length===0)return attachments;
  const sess=_sb?await _sb.auth.getSession():null;
  const token=sess?.data?.session?.access_token;
  if(!_sbUser||!token){
    toast('Sign in to attach evidence files — they\u2019re stored securely to your account.','warn',{duration:6000});
    return attachments;
  }
  for(const file of list){
    try{
      const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
      const path=`${_sbUser.id}/${entryId}/${Date.now()}_${safe}`;
      const res=await fetch(`${SUPABASE_URL}/storage/v1/object/Evidence/${path}`,{
        method:'POST',
        headers:{'Authorization':`Bearer ${token}`,'Content-Type':file.type||'application/octet-stream','x-upsert':'true'},
        body:file
      });
      if(res.ok){
        // Store only name + path. The viewable URL is generated on demand (signed, time-limited).
        attachments.push({name:file.name,path});
      } else { failed++; console.error('[uploadFiles] HTTP',res.status,file.name); }
    }catch(err){ failed++; console.error('[uploadFiles]',file?.name,err); }
  }
  if(failed>0){
    const total=list.length;
    if(failed===total){
      toast(`Could not upload ${failed} file${failed===1?'':'s'}. Your entry was saved without ${failed===1?'it':'them'}.`,'error');
    } else {
      toast(`${failed} of ${total} files failed to upload. The rest were attached.`,'warn');
    }
  }
  return attachments;
}

// Resolve a viewable URL for an attachment: prefer a short-lived SIGNED url (works with a private
// bucket), falling back to any legacy public url stored on older entries.
async function attUrl(att,expiresIn){
  try{
    if(att&&att.path&&_sb){
      const{data,error}=await _sb.storage.from('Evidence').createSignedUrl(att.path,expiresIn||3600);
      if(!error&&data&&data.signedUrl)return data.signedUrl;
    }
  }catch(e){}
  return (att&&att.url)||'';
}

async function openAtt(el){
  const path=el.dataset.path||'',url=el.dataset.url||'';
  const u=await attUrl({path,url});
  if(u){window.open(u,'_blank','noopener');}
  else{toast('Could not open this file. Older attachments may need to be re-uploaded after the storage update.','warn',{duration:6000});}
}

// After saving an entry, keep the active tax year in sync with the entry's date so
// a back-dated entry stays visible (and its totals correct) instead of silently
// dropping out of the year-scoped list. Warns if the date is outside tracked years.
function _syncYearToEntry(dateStr){
  const yr=parseInt((dateStr||'').slice(0,4));
  if(!yr||yr===activeYear)return;
  if(YEARS.includes(yr)){
    activeYear=yr;
    const ys=document.getElementById('year-sel');
    if(ys)ys.value=String(yr);
  } else {
    toast(`Saved — but this entry is dated ${yr}, outside the tax years RepsRecord tracks (${YEARS[0]}–${YEARS[YEARS.length-1]}), so it won't show in your logs.`,'warn',{duration:7000});
  }
}

async function submitEntry(){
  const h=(parseFloat(document.getElementById('f-hrs')?.value)||0)+(parseInt(document.getElementById('f-mins')?.value)||0)/60;
  if(h<=0){toast('Please enter a time greater than 0.','warn');return;}
  if(h>24){ const okBig=await dlgConfirm({title:'Unusually long entry',body:`That's ${h.toFixed(1)} hours for a single entry. A single day can't exceed 24 hours — save it anyway?`,confirmLabel:'Save anyway'}); if(!okBig)return; }
  const propId=document.getElementById('f-prop')?.value||'';
  if(!propId&&trackType==='STR'){toast('Please select an STR property. Go to Properties to add your STR properties first.','warn');return;}
  const btn=document.getElementById('sub-btn');
  if(btn){btn.disabled=true;btn.textContent=pendingFiles.length?'⬆ Uploading files…':'Saving…';}
  const _preHrs=calcREPS().rh;
  const cat=document.getElementById('f-cat')?.value||(trackType==='STR'?STR_CATS[0]:REPS_CATS[0]);
  const entryId=uid();
  let attachments=[];
  if(pendingFiles.length>0){
    try{attachments=await uploadFiles(entryId,pendingFiles);}
    catch(err){console.error('Upload error:',err);}
  }
  const _eDate=document.getElementById('f-date')?.value||todayStr();
  state.entries.push({id:entryId,date:_eDate,propertyId:propId,trackType,type:trackType,category:cat,hours:Math.round(h*100)/100,notes:document.getElementById('f-notes')?.value||'',isSpouse:!!document.getElementById('f-spouse')?.checked,attachments});
  _syncYearToEntry(_eDate);
  save();
  pendingFiles=[];
  const _newRH=calcREPS().rh;
  const _propHrs=propId?yearEntries().filter(e=>e.propertyId===propId&&!e.isSpouse&&e.trackType==='STR').reduce((s,e)=>s+(e.hours||0),0):0;
  const _saveMsg=trackType==='STR'?`✓ Saved! This property: ${Math.round(_propHrs)} hrs`:`✓ Saved! REPS total: ${Math.round(_newRH)} / >750 hrs`;
  if(btn){btn.textContent=_saveMsg;btn.style.background='#10B981';}
  setTimeout(()=>renderView(),1200);
}

async function delEntry(id){
  const ok=await dlgConfirm({title:'Delete entry',body:'Delete this time entry? You can undo this right after.',confirmLabel:'Delete',danger:true});
  if(!ok)return;
  const removed=state.entries.find(e=>e.id===id);
  state.entries=state.entries.filter(e=>e.id!==id);
  save();renderView();
  toast('Entry deleted.','info',{duration:5000,action:'Undo',onAction:()=>{ if(removed){state.entries.push(removed);save();renderView();toast('Restored.','success');} }});
}

function showEditEntry(id){
  const el=document.getElementById('edit-entry-'+id);
  if(!el)return;
  const isOpen=el.style.display!=='none';
  el.style.display=isOpen?'none':'block';
}

async function saveEditEntry(id){
  const entry=state.entries.find(e=>e.id===id);
  if(!entry)return;
  const hrs=parseFloat(document.getElementById('ee-hrs-'+id)?.value)||0;
  const mins=parseFloat(document.getElementById('ee-min-'+id)?.value)||0;
  const total=hrs+(mins/60);
  if(total>24){ const okBig=await dlgConfirm({title:'Unusually long entry',body:`That's ${total.toFixed(1)} hours for a single entry. A single day can't exceed 24 hours — save it anyway?`,confirmLabel:'Save anyway'}); if(!okBig)return; }
  entry.date=document.getElementById('ee-date-'+id)?.value||entry.date;
  entry.hours=total;
  entry.category=document.getElementById('ee-cat-'+id)?.value||entry.category;
  entry.notes=document.getElementById('ee-note-'+id)?.value||'';
  _syncYearToEntry(entry.date);
  save();renderView();
}

function delAttachment(entryId,name){
  const entry=state.entries.find(e=>e.id===entryId);
  if(!entry)return;
  entry.attachments=(entry.attachments||[]).filter(a=>a.name!==name);
  save();renderView();
}

// ── PROPERTIES ──
function vProps(){
  return`
<div class="ph">
  <div class="ph-row">
    <div><h1 class="pg-title">Properties</h1><div class="pg-sub">LTR properties count toward your REPS 750-hr total. STRs are evaluated for all 7 material participation tests.</div></div>
    <button class="btn btn-teal" data-act="togglePF">+ Add Property</button>
  </div>
</div>
${showPropForm?`
<div class="card card-mb" style="border-color:#14B8A6;">
  <h2 class="sec-lbl" style="margin-bottom:12px;">New Property</h2>
  <div class="g2">
    <div class="field"><label class="fl">Nickname / Name</label><input id="p-nm" placeholder="e.g. Kissimmee STR, Blue Ridge Cabin"/></div>
    <div class="field"><label class="fl">Type</label><select id="p-tp" data-chg="togglePropType"><option value="STR">STR — Short-Term Rental</option><option value="LTR">LTR — Long-Term Rental</option></select></div>
  </div>
  <div class="field">
    <label class="fl">Address Search <span style="font-weight:400;text-transform:none;color:#94A3B8;">— type to search and autofill</span></label>
    <input id="p-addr-search" placeholder="Start typing the property address..." autocomplete="off" data-inp="addrSearch" style="position:relative;"/>
    <div id="p-addr-suggestions" style="display:none;position:absolute;z-index:100;background:#fff;border:1.5px solid #CCFBF1;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:200px;overflow-y:auto;margin-top:2px;min-width:340px;"></div>
  </div>
  <div class="g2">
    <div class="field" style="grid-column:1/-1"><label class="fl">Street Address</label><input id="p-street" placeholder="123 Main Street" autocomplete="street-address"/></div>
  </div>
  <div class="g3" style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;">
    <div class="field"><label class="fl">City</label><input id="p-city" placeholder="Orlando" autocomplete="address-level2"/></div>
    <div class="field"><label class="fl">State</label><input id="p-state" placeholder="FL" maxlength="2" autocomplete="address-level1" style="text-transform:uppercase;"/></div>
    <div class="field"><label class="fl">ZIP</label><input id="p-zip" placeholder="32801" maxlength="5" autocomplete="postal-code"/></div>
  </div>
  <div id="str-fields">
  <div class="g2">
    <div class="field"><label class="fl">Avg Rental Period (days)</label><input type="number" id="p-dy" min="0.5" step="0.5" placeholder="e.g. 4.5"/><div class="hint">≤7 days = strongest eligibility. 8–30 days may still qualify. <strong>Don't know yet?</strong> Leave blank — use the <strong>Booking Log</strong> (available after saving this property) to auto-calculate from your individual bookings.</div></div>
    <div class="field"><label class="fl">Other Participants' Annual Hours</label><input type="number" id="p-ot" min="0" step="1" placeholder="e.g. 50"/><div class="hint">Hours/year your cleaner, co-host, or PM spends on this property — used to check if your hours exceed theirs (key to the most common qualification test).</div></div>
    <label class="tog-row" style="margin-top:-4px;"><input type="checkbox" id="p-ot-comp"/><span class="tog-lbl">These hours are paid management (co-host / PM compensated to manage) — disqualifies Test 7 per §1.469-5T(b)(2)(ii)</span></label>
  </div>
  </div>
  <div style="display:flex;gap:8px;">
    <button class="btn btn-teal" data-act="addProp">Save Property</button>
    <button class="btn btn-outline" data-act="togglePF">Cancel</button>
  </div>
</div></div>`:''}
${state.properties.length===0?`<div class="empty"><div class="empty-ic">🏠</div><div class="empty-tx">No properties yet — add your first LTR or STR above.</div></div>`:''}
${state.properties.map(p=>{
  const hrs=yearEntries().filter(e=>e.propertyId===p.id&&!e.isSpouse).reduce((s,e)=>s+(e.hours||0),0);
  const propEntries=yearEntries().filter(e=>e.propertyId===p.id).sort((a,b)=>new Date(b.date)-new Date(a.date));
  return`<div class="prop-c ${p.type==='LTR'?'ltr':''}" style="flex-direction:column;gap:0;position:relative;">
  <div style="position:absolute;top:0;right:0;">
    <button data-act="openQuickLog" data-id="${p.id}" style="background:#14B8A6;color:#fff;border:none;font-size:12px;font-weight:700;padding:7px 14px;border-radius:0 10px 0 10px;cursor:pointer;letter-spacing:.01em;" aria-label="Log time for ${esc(p.name)}">⏱ Log Time</button>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-right:90px;">
    <div>
      <div class="prop-nm">${esc(p.name)}</div>${p.address?`<div class="prop-addr">${esc(p.address)}</div>`:''}
      <div class="prop-tags">
        <span class="badge ${p.type==='STR'?'b-blue':'b-amber'}">${p.type}</span>
        ${p.type==='STR'&&p.avgRentalDays?`<span class="badge ${p.avgRentalDays<=7?'b-met':'b-no'}">Avg ${p.avgRentalDays}d ${p.avgRentalDays<=7?'✓':'⚠'}${p.bookings&&p.bookings.length?' 📅':''}</span>`:''}
        ${p.otherHours>0?`<span style="font-size:11px;color:#64748B;">Others: ${p.otherHours}h/yr</span>`:''}
      </div>
    </div>
    <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
      <div style="font-size:26px;font-weight:900;color:#0D1F3C;margin-top:28px;">${Math.round(hrs)}<span style="font-size:13px;font-weight:400;color:#64748B;"> hrs</span></div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm" style="background:#F0FDFA;border:1px solid #CCFBF1;color:#0E7490;font-size:11px;" data-act="togglePropEntries" data-id="${p.id}">📋 View Entries (${propEntries.length})</button>
        ${p.type==='STR'?`<button class="btn btn-sm" style="background:#FEF3C7;border:1px solid #FDE68A;color:#92400E;font-size:11px;" data-act="toggleBookingLog" data-id="${p.id}">📅 Bookings (${(p.bookings||[]).length})</button>`:''}
        <button class="btn btn-sm" style="background:#EFF6FF;border:1px solid #BFDBFE;color:#1D4ED8;font-size:11px;" data-act="toggleEditProp" data-id="${p.id}">✏️ Edit</button>
        <button class="btn btn-sm btn-danger" style="display:flex;align-items:center;gap:4px;font-size:11px;" aria-label="Delete property ${esc(p.name)}" data-act="rmProp" data-id="${p.id}">🗑 Delete</button>
      </div>
    </div>
  </div>
  <div id="quick-log-${p.id}" style="display:none;margin-top:14px;border-top:1px solid #14B8A6;padding-top:14px;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#14B8A6;margin-bottom:12px;">⏱ Log Time — ${esc(p.name)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div class="field"><label class="fl">Date</label><input type="date" id="ql-date-${p.id}" value="${todayStr()}" max="${todayStr()}"/></div>
      <div class="field"><label class="fl">Track Type</label>
        <select id="ql-tt-${p.id}" disabled aria-label="Track type — locked to property type" style="background:#F1F5F9;color:#64748B;cursor:not-allowed;">
          <option value="${p.type==='LTR'?'REPS':'STR'}" selected>${p.type==='LTR'?'REPS — Real Estate Professional':'STR — Short-Term Rental'}</option>
        </select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div class="field"><label class="fl">Hours</label><input type="number" id="ql-hrs-${p.id}" min="0" max="24" step="1" placeholder="0"/></div>
      <div class="field"><label class="fl">Minutes</label><select id="ql-min-${p.id}"><option value="0">0 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option></select></div>
    </div>
    <div class="field" style="margin-bottom:10px;"><label class="fl">Activity Category</label>
      <select id="ql-cat-${p.id}">
        ${(p.type==='STR'?STR_CATS:REPS_CATS).map(c=>`<option value="${c}">${c}</option>`).join('')}
      </select>
    </div>
    <div class="field" style="margin-bottom:12px;"><label class="fl">Notes / Description</label>
      <textarea id="ql-note-${p.id}" rows="2" placeholder="What did you do? Be specific — this is your audit record."></textarea>
    </div>
    <div class="field" style="margin-bottom:12px;">
      <label class="fl">Evidence / Attachments <span style="font-weight:400;color:#94A3B8;">(optional)</span></label>
      <input type="file" id="ql-files-${p.id}" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" style="width:100%;padding:8px 12px;border:1.5px solid #CBD5E1;border-radius:8px;background:#F8FAFC;font-size:13px;font-family:inherit;cursor:pointer;"/>
      <div class="hint">Attach receipts, photos, invoices, or contracts</div>
    </div>
    ${state.settings.spouseEnabled?`<label class="tog-row" style="margin-bottom:12px;"><input type="checkbox" id="ql-spouse-${p.id}"/><span class="tog-lbl">Log as ${state.settings.spouseName||'Spouse'}'s hours (tracked separately for MP Tests 3 & 7)</span></label>`:''}
    <div style="display:flex;gap:8px;">
      <button data-act="saveQuickLog" data-id="${p.id}" style="background:#14B8A6;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">Save Entry</button>
      <button data-act="hideQuickLog" data-id="${p.id}" style="background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0;padding:9px 14px;border-radius:8px;font-size:13px;cursor:pointer;">Cancel</button>
    </div>
  </div>
  <div id="edit-prop-${p.id}" style="display:none;margin-top:14px;border-top:1px solid #CBD5E1;padding-top:14px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="field"><label class="fl">Property Name</label><input id="ep-nm-${p.id}" value="${p.name.replace(/"/g,'&quot;')}"/></div>
      <div class="field"><label class="fl">Type</label>
        <select id="ep-tp-${p.id}" data-chg="toggleEditPropType" data-id="${p.id}">
          <option value="STR" ${p.type==='STR'?'selected':''}>STR — Short-Term Rental</option>
          <option value="LTR" ${p.type==='LTR'?'selected':''}>LTR — Long-Term Rental</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-bottom:12px;"><label class="fl">Street Address</label><input id="ep-street-${p.id}" value="${(p.street||p.address||'').replace(/"/g,'&quot;')}"/></div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="field"><label class="fl">City</label><input id="ep-city-${p.id}" value="${(p.city||'').replace(/"/g,'&quot;')}"/></div>
      <div class="field"><label class="fl">State</label><input id="ep-state-${p.id}" value="${(p.state||'').replace(/"/g,'&quot;')}" maxlength="2" style="text-transform:uppercase;"/></div>
      <div class="field"><label class="fl">ZIP</label><input id="ep-zip-${p.id}" value="${(p.zip||'').replace(/"/g,'&quot;')}" maxlength="5"/></div>
    </div>
    <div id="ep-str-fields-${p.id}" style="${p.type==='LTR'?'display:none':''}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div class="field"><label class="fl">Avg Rental Period (days)</label><input type="number" id="ep-dy-${p.id}" value="${p.avgRentalDays||''}" min="0.5" step="0.5" placeholder="e.g. 4.5"/><div class="hint">${(p.bookings&&p.bookings.length>0)?`📅 Auto-calculated from ${p.bookings.length} booking${p.bookings.length>1?'s':''}. Use Booking Log to update.`:'≤7 days = strongest eligibility. 8–30 days may qualify with significant personal services.'}</div></div>
        <div class="field"><label class="fl">Other Participants' Annual Hours</label><input type="number" id="ep-ot-${p.id}" value="${p.otherHours||0}" min="0" step="1"/><div class="hint">Hours/year your cleaner, co-host, or PM spends on this property.</div></div>
      </div>
      <label class="tog-row" style="margin-bottom:12px;"><input type="checkbox" id="ep-ot-comp-${p.id}" ${p.otherHoursCompensated?'checked':''}/><span class="tog-lbl">These hours are paid management (co-host / PM compensated to manage) — disqualifies Test 7 per §1.469-5T(b)(2)(ii)</span></label>
    </div>
    <div style="display:flex;gap:8px;">
      <button data-act="savePropEdit" data-id="${p.id}" style="background:#14B8A6;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">Save changes</button>
      <button data-act="toggleEditProp" data-id="${p.id}" style="background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0;padding:9px 14px;border-radius:8px;font-size:13px;cursor:pointer;">Cancel</button>
    </div>
  </div>
  <div id="booking-log-${p.id}" style="display:none;margin-top:14px;border-top:2px solid #FDE68A;padding-top:14px;">
    ${p.type==='STR'?`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div>
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#92400E;">📅 Booking Log — ${esc(p.name)}</div>
        <div style="font-size:11px;color:#64748B;margin-top:2px;">Each booking's nights auto-calculate your average rental period (IRS method: total nights ÷ number of bookings)</div>
      </div>
      ${(p.bookings||[]).length>0?`<span class="badge ${(calcAvgFromBookings(p.id)||0)<=7?'b-met':'b-no'}" style="font-size:12px;padding:5px 12px;">Calculated Avg: ${calcAvgFromBookings(p.id)||'—'}d</span>`:''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;margin-bottom:12px;align-items:end;">
      <div class="field" style="margin-bottom:0;"><label class="fl">Check-In</label><input type="date" id="bk-in-${p.id}" value="${todayStr()}"/></div>
      <div class="field" style="margin-bottom:0;"><label class="fl">Check-Out</label><input type="date" id="bk-out-${p.id}" value="${todayStr()}"/></div>
      <button data-act="addBooking" data-id="${p.id}" style="background:#F59E0B;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;height:40px;">+ Add Booking</button>
    </div>
    ${(p.bookings||[]).length===0?`<div style="text-align:center;padding:16px;color:#94A3B8;font-size:13px;background:#FFFBEB;border-radius:8px;">No bookings logged yet — add your first booking above.</div>`:`
    <div style="background:#FFFBEB;border-radius:8px;padding:2px 0;margin-bottom:8px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:340px;">
        <thead><tr>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#92400E;border-bottom:1px solid #FDE68A;">Check-In</th>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#92400E;border-bottom:1px solid #FDE68A;">Check-Out</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#92400E;border-bottom:1px solid #FDE68A;">Nights</th>
          <th style="padding:8px 12px;border-bottom:1px solid #FDE68A;"></th>
        </tr></thead>
        <tbody>${(p.bookings||[]).sort((a,b)=>new Date(b.checkIn)-new Date(a.checkIn)).map(b=>{const n=Math.round((new Date(b.checkOut)-new Date(b.checkIn))/(1000*60*60*24));return`<tr>
          <td style="padding:7px 12px;color:#0D1F3C;">${b.checkIn}</td>
          <td style="padding:7px 12px;color:#0D1F3C;">${b.checkOut}</td>
          <td style="padding:7px 12px;text-align:center;font-weight:700;color:${n<=7?'#065F46':'#92400E'};">${n}d</td>
          <td style="padding:7px 12px;text-align:right;"><button data-act="delBooking" data-id="${p.id}" data-id2="${b.id}" style="background:#FEE2E2;border:1px solid #FECACA;color:#DC2626;font-size:11px;padding:3px 8px;border-radius:5px;cursor:pointer;">✕</button></td>
        </tr>`;}).join('')}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:8px 12px;">
      📐 IRS calculation: ${(p.bookings||[]).reduce((s,b)=>s+Math.max(0,Math.round((new Date(b.checkOut)-new Date(b.checkIn))/(1000*60*60*24))),0)} total nights ÷ ${(p.bookings||[]).length} booking${(p.bookings||[]).length===1?'':'s'} = <strong>${calcAvgFromBookings(p.id)||'—'} day average</strong> — Property ${(calcAvgFromBookings(p.id)||0)<=7?'✓ qualifies':'⚠ does not qualify'} for §469 STR exception
    </div>`}
    `:'<div style="color:#94A3B8;font-size:12px;">Booking log is only available for STR properties.</div>'}
  </div>
  <div id="prop-entries-${p.id}" style="display:none;margin-top:14px;border-top:1px solid #F0FDFA;padding-top:12px;">
    ${propEntries.length===0
      ? `<div style="text-align:center;padding:16px;color:#94A3B8;font-size:13px;">No entries for this property yet.</div>`
      : propEntries.map(e=>`
    <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:.5px solid #F0FDFA;">
      <div style="font-size:18px;">${e.trackType==='STR'?'🏖':'🏡'}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:700;color:#0D1F3C;">${esc(e.category)}<span style="font-size:10px;font-weight:400;color:#64748B;margin-left:6px;">${e.date} · ${fmtH(e.hours)}</span></div>
        ${e.notes?`<div style="font-size:12px;color:#64748B;margin-top:2px;font-style:italic;">"${esc(e.notes)}"</div>`:''}
        ${e.attachments&&e.attachments.length?`<div style="font-size:11px;color:#0F766E;margin-top:2px;">📎 ${e.attachments.length} attachment${e.attachments.length>1?'s':''}</div>`:''}
      </div>
      <div style="display:flex;gap:5px;flex-shrink:0;">
        <button data-act="showEditEntry" data-id="${e.id}" style="background:#F0FDFA;border:1px solid #CCFBF1;color:#0E7490;font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;">✏️ Edit</button>
        <button data-act="delEntry" data-id="${e.id}" style="background:#FEE2E2;border:1px solid #FECACA;color:#DC2626;font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;">🗑 Delete</button>
      </div>
    </div>
    <div id="edit-entry-${e.id}" style="display:none;margin-top:8px;background:#F8FAFC;border:1.5px solid #CBD5E1;border-radius:10px;padding:14px;">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px;">
        <div class="field"><label class="fl">Date</label><input type="date" id="ee-date-${e.id}" value="${e.date}" max="${todayStr()}"/></div>
        <div class="field"><label class="fl">Hours</label><input type="number" id="ee-hrs-${e.id}" value="${Math.floor(e.hours)}" min="0" max="24" step="1"/></div>
        <div class="field"><label class="fl">Minutes</label><input type="number" id="ee-min-${e.id}" value="${Math.round((e.hours % 1)*60)}" min="0" max="59" step="15"/></div>
      </div>
      <div class="field" style="margin-bottom:10px;"><label class="fl">Category</label>
        <select id="ee-cat-${e.id}">
          ${(e.trackType==='STR'?STR_CATS:REPS_CATS).map(c=>`<option value="${c}" ${c===e.category?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:10px;"><label class="fl">Notes</label><textarea id="ee-note-${e.id}" rows="2">${esc(e.notes||'')}</textarea></div>
      <div style="display:flex;gap:8px;">
        <button data-act="saveEditEntry" data-id="${e.id}" style="background:#14B8A6;color:#fff;border:none;padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">Save changes</button>
        <button data-act="hideEditEntry" data-id="${e.id}" style="background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0;padding:8px 14px;border-radius:8px;font-size:12px;cursor:pointer;">Cancel</button>
      </div>
    </div>`).join('')}
  </div>
</div>`;}).join('')}`;
}

// ── ADDRESS AUTOCOMPLETE (OpenStreetMap Nominatim - free, no key) ──
let addrTimer=null;
function addrSearch(q){
  clearTimeout(addrTimer);
  const box=document.getElementById('p-addr-suggestions');
  if(!q||q.length<4){if(box)box.style.display='none';return;}
  addrTimer=setTimeout(async()=>{
    try{
      const res=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&format=json&addressdetails=1&limit=5`,{headers:{'Accept-Language':'en'}});
      const data=await res.json();
      if(!box)return;
      if(!data.length){box.style.display='none';return;}
      box.innerHTML=data.map((r,i)=>`<div class="hov-row" data-act="fillAddr" data-idx="${i}" data-addr='${JSON.stringify({street:(r.address.house_number?r.address.house_number+' ':'')+( r.address.road||r.address.pedestrian||''),city:r.address.city||r.address.town||r.address.village||r.address.county||'',state:r.address.state||'',zip:r.address.postcode||''}).replace(/'/g,"&apos;")}' style="padding:10px 14px;cursor:pointer;font-size:13px;color:#0D1F3C;border-bottom:1px solid #F0FDFA;">${r.display_name}</div>`).join('');
      box.style.display='block';
    }catch(e){if(box)box.style.display='none';}
  },400);
}
// Maps Nominatim's full state names to USPS 2-letter codes (address autofill fix).
const US_STATE_CODES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','district of columbia':'DC',
  'florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID','illinois':'IL',
  'indiana':'IN','iowa':'IA','kansas':'KS','kentucky':'KY','louisiana':'LA',
  'maine':'ME','maryland':'MD','massachusetts':'MA','michigan':'MI','minnesota':'MN',
  'mississippi':'MS','missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR',
  'pennsylvania':'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',
  'tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT','virginia':'VA',
  'washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'puerto rico':'PR','guam':'GU','u.s. virgin islands':'VI'
};
function toStateCode(name){
  if(!name) return '';
  const key = String(name).trim().toLowerCase();
  if(US_STATE_CODES[key]) return US_STATE_CODES[key];  // full name -> code
  if(key.length===2) return key.toUpperCase();         // already a 2-letter code
  return '';                                           // unknown -> blank, never a wrong guess
}
function fillAddr(i){
  const box=document.getElementById('p-addr-suggestions');
  const items=box?.querySelectorAll('[data-addr]');
  if(!items||!items[i])return;
  const a=JSON.parse(items[i].getAttribute('data-addr').replace(/&apos;/g,"'"));
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val;};
  set('p-street',a.street);
  set('p-city',a.city);
  set('p-state',toStateCode(a.state));
  set('p-zip',a.zip);
  set('p-addr-search',a.street+(a.city?', '+a.city:'')+(a.state?', '+a.state:''));
  box.style.display='none';
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#p-addr-search')&&!e.target.closest('#p-addr-suggestions')){
    const b=document.getElementById('p-addr-suggestions');if(b)b.style.display='none';
  }
});

function openQuickLog(propId){
  const prop=state.properties.find(p=>p.id===propId);
  if(!prop)return;
  // Close any other open quick logs
  document.querySelectorAll('[id^="quick-log-"]').forEach(el=>el.style.display='none');
  const el=document.getElementById('quick-log-'+propId);
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
  // Set today's date
  const d=document.getElementById('ql-date-'+propId);
  if(d&&!d.value)d.value=new Date().toISOString().slice(0,10);
}

function updateQLCats(propId){
  const tt=document.getElementById('ql-tt-'+propId)?.value;
  const cats=tt==='STR'?STR_CATS:REPS_CATS;
  const sel=document.getElementById('ql-cat-'+propId);
  if(!sel)return;
  sel.innerHTML=cats.map(c=>`<option value="${c}">${c}</option>`).join('');
}

async function saveQuickLog(propId){
  const hrs=parseFloat(document.getElementById('ql-hrs-'+propId)?.value)||0;
  const mins=parseFloat(document.getElementById('ql-min-'+propId)?.value)||0;
  if(hrs+mins<=0){toast('Please enter a time greater than 0.','warn');return;}
  if(hrs+mins/60>24){ const okBig=await dlgConfirm({title:'Unusually long entry',body:`That's ${(hrs+mins/60).toFixed(1)} hours for a single entry. A single day can't exceed 24 hours — save it anyway?`,confirmLabel:'Save anyway'}); if(!okBig)return; }
  const btn=document.querySelector(`#quick-log-${propId} button`);
  if(btn){btn.disabled=true;btn.textContent='Saving…';}
  const tt=document.getElementById('ql-tt-'+propId)?.value||'REPS';
  const entryId=uid();
  // Handle file uploads
  const fileInput=document.getElementById('ql-files-'+propId);
  let attachments=[];
  if(fileInput?.files?.length>0){
    const pendingFiles=Array.from(fileInput.files);
    attachments=await uploadFiles(entryId,pendingFiles);
  }
  state.entries.push({
    id:entryId,
    date:document.getElementById('ql-date-'+propId)?.value||todayStr(),
    propertyId:propId,
    trackType:tt,
    type:tt,
    category:document.getElementById('ql-cat-'+propId)?.value||REPS_CATS[0],
    hours:Math.round((hrs+mins/60)*100)/100,
    notes:document.getElementById('ql-note-'+propId)?.value||'',
    isSpouse:!!document.getElementById('ql-spouse-'+propId)?.checked,
    attachments
  });
  _syncYearToEntry(document.getElementById('ql-date-'+propId)?.value||todayStr());
  save();renderView();
}

function toggleEditProp(id){
  const el=document.getElementById('edit-prop-'+id);
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
}

function toggleEditPropType(id){
  const tp=document.getElementById('ep-tp-'+id)?.value;
  const sf=document.getElementById('ep-str-fields-'+id);
  if(sf)sf.style.display=tp==='LTR'?'none':'block';
}

function savePropEdit(id){
  const prop=state.properties.find(p=>p.id===id);
  if(!prop)return;
  const street=document.getElementById('ep-street-'+id)?.value?.trim()||'';
  const city=document.getElementById('ep-city-'+id)?.value?.trim()||'';
  const st=document.getElementById('ep-state-'+id)?.value?.trim().toUpperCase()||'';
  const zip=document.getElementById('ep-zip-'+id)?.value?.trim()||'';
  prop.name=document.getElementById('ep-nm-'+id)?.value?.trim()||prop.name;
  prop.type=document.getElementById('ep-tp-'+id)?.value||prop.type;
  prop.street=street;prop.city=city;prop.state=st;prop.zip=zip;
  prop.address=[street,city,st,zip].filter(Boolean).join(', ');
  // If bookings exist, recalculate avg from actual booking data; manual edit only applies when no bookings logged
  const manualAvg=parseFloat(document.getElementById('ep-dy-'+id)?.value)||null;
  const recalcAvg=calcAvgFromBookings(id);
  prop.avgRentalDays=recalcAvg!==null?recalcAvg:manualAvg;
  prop.otherHours=parseFloat(document.getElementById('ep-ot-'+id)?.value)||0;
  prop.otherHoursCompensated=!!document.getElementById('ep-ot-comp-'+id)?.checked;
  save();renderView();
}

function togglePropEntries(id){
  const el=document.getElementById('prop-entries-'+id);
  if(!el)return;
  const isOpen=el.style.display!=='none';
  el.style.display=isOpen?'none':'block';
}

// ── IMPORT FROM EXCEL ──
let _importRows = [];

let _importPrevFocus=null,_importKeyHandler=null;
function showImportModal(){
  const m = document.getElementById('import-modal');
  if(!m) return;
  _importPrevFocus=document.activeElement;
  m.style.display='flex';
  _importKeyHandler=function(e){
    if(e.key==='Escape'){ e.preventDefault(); closeImportModal(); return; }
    if(e.key==='Tab'){
      const f=[...m.querySelectorAll('button,input,[tabindex]')].filter(el=>el.getClientRects().length>0&&!el.disabled);
      if(!f.length)return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown',_importKeyHandler,true);
  setTimeout(function(){ const f=m.querySelector('button,input,[tabindex]'); if(f)f.focus(); },50);
}

function downloadImportTemplate(){
  const headers='date,hours,minutes,property,type,category,notes';
  const example1=`${activeYear}-01-15,2,30,My STR Property,STR,Guest Communication,Responded to 3 guest inquiries re check-in instructions`;
  const example2=`${activeYear}-01-16,1,0,My LTR Property,REPS,Property Management,Called tenant re lease renewal — confirmed another year`;
  const csv=[headers,example1,example2].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='repsrecord_import_template.csv';
  document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}

function closeImportModal(){
  const m = document.getElementById('import-modal');
  if(m){ m.style.display='none'; }
  if(_importKeyHandler){ document.removeEventListener('keydown',_importKeyHandler,true); _importKeyHandler=null; }
  _importRows = [];
  const s = document.getElementById('import-status');
  if(s){ s.style.display='none'; s.innerHTML=''; }
  const btn = document.getElementById('import-confirm-btn');
  if(btn) btn.style.display='none';
  const fi = document.getElementById('import-file');
  if(fi) fi.value='';
  if(_importPrevFocus&&_importPrevFocus.focus){ try{_importPrevFocus.focus();}catch(_){} _importPrevFocus=null; }
}

async function handleImportFile(input){
  const file = input.files[0];
  if(!file) return;
  const status = document.getElementById('import-status');
  status.style.display='block';
  status.innerHTML = '<div style="color:#64748B;font-size:13px;"><span class="spinner"></span> Reading file…</div>';

  try {
    let rows = [];
    if(file.name.endsWith('.csv')){
      const text = await file.text();
      rows = parseCSV(text);
    } else {
      // Load SheetJS from CDN
      if(!window.XLSX){
        status.innerHTML = '<div style="color:#64748B;font-size:13px;"><span class="spinner"></span> Loading Excel library…</div>';
        await new Promise((res,rej)=>{
          const s=document.createElement('script');
          s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          s.onload=res; s.onerror=()=>rej(new Error('Could not load Excel library — check your connection'));
          document.head.appendChild(s);
        });
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, {defval:''});
      rows = data;
    }

    // Validate and map rows
    const required = ['date','hours','property','type'];
    const sample = rows[0] ? Object.keys(rows[0]).map(k=>k.toLowerCase()) : [];
    const missing = required.filter(r => !sample.includes(r));
    if(missing.length){
      status.innerHTML = `<div style="background:#FEE2E2;border-radius:8px;padding:12px;font-size:13px;color:#991B1B;">❌ Missing required columns: <strong>${missing.join(', ')}</strong><br>Check your column headers match exactly.</div>`;
      return;
    }

    // Normalize keys to lowercase
    const normalized = rows.map(r => {
      const obj = {};
      Object.keys(r).forEach(k => obj[k.toLowerCase().trim()] = String(r[k]).trim());
      return obj;
    }).filter(r => r.date && r.hours && r.property);

    // Match properties
    let matched=0, unmatched=[], entries=[], skipped=0;
    // BATCH 2: validate date format (YYYY-MM-DD), clamp hours, cap notes length, restrict type/category
    const dateRe=/^\d{4}-\d{2}-\d{2}$/;
    normalized.forEach(r => {
      const prop = state.properties.find(p => p.name.toLowerCase() === r.property.toLowerCase());
      const hrs = parseFloat(r.hours)||0;
      const mins = parseFloat(r.minutes||0);
      let total = (hrs + mins/60);
      if(!isFinite(total)||total<=0){skipped++;return;}
      total = Math.min(24, Math.max(0, total));// clamp to 0-24
      total = Math.round(total*100)/100;
      const tt = (r.type||'REPS').toUpperCase() === 'STR' ? 'STR' : 'REPS';
      const cats = tt==='STR' ? STR_CATS : REPS_CATS;
      const cat = cats.find(c=>c.toLowerCase()===( r.category||'').toLowerCase()) || cats[0];
      if(!prop){ unmatched.push(r.property); return; }
      // Date validation: must be YYYY-MM-DD; tolerate Excel date-as-string but reject garbage
      let dateStr = r.date;
      if(!dateRe.test(dateStr)){
        // Try to parse common alternate formats (M/D/YYYY, YYYY/MM/DD)
        const d=new Date(dateStr);
        if(isNaN(d.getTime())){skipped++;return;}
        dateStr=d.toISOString().slice(0,10);
      }
      // Cap notes length to prevent denial-of-service via huge text
      const notes=(r.notes||'').slice(0, 2000);
      entries.push({
        id: uid(),
        date: dateStr,
        propertyId: prop.id,
        trackType: tt,
        type: tt,
        category: cat,
        hours: total,
        notes: notes,
        isSpouse: false,
        attachments: []
      });
      matched++;
    });

    _importRows = entries;
    const unmatchedUniq = [...new Set(unmatched)];
    let html = `<div style="background:#F0FDFA;border-radius:8px;padding:14px;font-size:13px;color:#0E7490;">
      ✅ <strong>${matched} entries</strong> ready to import`;
    if(unmatchedUniq.length){
      html += `<br><span style="color:#B45309;">⚠️ ${unmatched.length} rows skipped — property not found: <strong>${esc(unmatchedUniq.join(', '))}</strong></span>`;
    }
    if(skipped>0){
      html += `<br><span style="color:#B45309;">⚠️ ${skipped} rows skipped — invalid date or hours.</span>`;
    }
    html += '</div>';
    status.innerHTML = html;

    const btn = document.getElementById('import-confirm-btn');
    if(btn) btn.style.display = matched > 0 ? 'inline-block' : 'none';

  } catch(err){
    status.innerHTML = `<div style="background:#FEE2E2;border-radius:8px;padding:12px;font-size:13px;color:#991B1B;">❌ Error reading file: ${esc(err.message||'unknown error')}</div>`;
  }
}

function parseCSV(text){
  const lines = text.split('\n').filter(l=>l.trim());
  if(lines.length < 2) return [];
  const headers = lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,'').toLowerCase());
  return lines.slice(1).map(line=>{
    const vals = line.split(',').map(v=>v.trim().replace(/^"|"$/g,''));
    const obj = {};
    headers.forEach((h,i)=>obj[h]=vals[i]||'');
    return obj;
  });
}

function confirmImport(){
  if(!_importRows.length) return;
  state.entries.push(..._importRows);
  save();
  closeImportModal();
  renderView();
  toast(`Successfully imported ${_importRows.length} entries.`,'success');
}

function setDashTab(tab){
  window._dashTab = tab;
  renderView();
}

function togglePropType(){
  const tp=document.getElementById('p-tp')?.value;
  const strFields=document.getElementById('str-fields');
  if(strFields) strFields.style.display=tp==='LTR'?'none':'block';
}

function togglePF(){showPropForm=!showPropForm;renderView();}
function addProp(){
  const nm=document.getElementById('p-nm')?.value?.trim();
  if(!nm){toast('Please enter a property name.','warn');return;}
  const tp=document.getElementById('p-tp')?.value||'STR';
  const street=document.getElementById('p-street')?.value?.trim()||'';
  const city=document.getElementById('p-city')?.value?.trim()||'';
  const state2=document.getElementById('p-state')?.value?.trim().toUpperCase()||'';
  const zip=document.getElementById('p-zip')?.value?.trim()||'';
  const address=[street,city,state2,zip].filter(Boolean).join(', ');
  state.properties.push({id:uid(),name:nm,address,street,city,state:state2,zip,type:tp,avgRentalDays:parseFloat(document.getElementById('p-dy')?.value)||null,otherHours:parseFloat(document.getElementById('p-ot')?.value)||0,otherHoursCompensated:!!document.getElementById('p-ot-comp')?.checked,bookings:[]});
  save();showPropForm=false;renderView();
}
async function rmProp(id){
  const prop=state.properties.find(p=>p.id===id);
  if(!prop)return;
  const affectedIds=state.entries.filter(e=>e.propertyId===id).map(e=>e.id);
  const entryCount=affectedIds.length;
  const ok=await dlgConfirm({title:'Delete property',body:`Delete property "${prop.name}"?`,confirmLabel:'Delete',danger:true});
  if(!ok)return;
  const removedProp=JSON.parse(JSON.stringify(prop));
  let keepEntries=true;
  let removedEntries=null;
  state.properties=state.properties.filter(p=>p.id!==id);
  if(entryCount>0){
    // confirmLabel ("Keep entries") → keep; cancelLabel ("Delete entries") is the destructive option (intentional UX)
    keepEntries=await dlgConfirm({
      title:'Keep this property\u2019s entries?',
      body:`This property has ${entryCount} time ${entryCount===1?'entry':'entries'}.\n\n"Keep entries" reassigns them to General RE.\n"Delete entries" permanently removes all ${entryCount}.`,
      confirmLabel:'Keep entries',
      cancelLabel:'Delete entries'
    });
    if(keepEntries){
      state.entries=state.entries.map(e=>e.propertyId===id?{...e,propertyId:null}:e);
    } else {
      removedEntries=state.entries.filter(e=>e.propertyId===id).map(e=>JSON.parse(JSON.stringify(e)));
      state.entries=state.entries.filter(e=>e.propertyId!==id);
    }
  }
  save();renderView();
  toast(`Property "${prop.name}" deleted.`,'info',{duration:6000,action:'Undo',onAction:()=>{
    state.properties.push(removedProp);
    if(entryCount>0){
      if(keepEntries){
        // re-attribute the General-RE'd entries back to this property
        state.entries=state.entries.map(e=>affectedIds.includes(e.id)?{...e,propertyId:id}:e);
      } else if(removedEntries){
        state.entries.push(...removedEntries);
      }
    }
    save();renderView();toast('Property restored.','success');
  }});
}


// ── BOOKING LOG ──
function calcAvgFromBookings(pid){
  const p=state.properties.find(x=>x.id===pid);
  if(!p||!p.bookings||!p.bookings.length)return null;
  const total=p.bookings.reduce((s,b)=>{
    const nights=Math.round((new Date(b.checkOut)-new Date(b.checkIn))/(1000*60*60*24));
    return s+(nights>0?nights:0);
  },0);
  return total>0?Math.round((total/p.bookings.length)*10)/10:null;
}
function toggleBookingLog(pid){
  const el=document.getElementById('booking-log-'+pid);
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
}
function addBooking(pid){
  const cin=document.getElementById('bk-in-'+pid)?.value;
  const cout=document.getElementById('bk-out-'+pid)?.value;
  if(!cin||!cout){toast('Please enter both check-in and check-out dates.','warn');return;}
  if(new Date(cout)<=new Date(cin)){toast('Check-out must be after check-in.','warn');return;}
  const p=state.properties.find(x=>x.id===pid);
  if(!p)return;
  if(!p.bookings)p.bookings=[];
  p.bookings.push({id:uid(),checkIn:cin,checkOut:cout});
  // Auto-update avgRentalDays from bookings
  const avg=calcAvgFromBookings(pid);
  if(avg!==null)p.avgRentalDays=avg;
  save();renderView();
}
async function delBooking(pid,bid){
  const p=state.properties.find(x=>x.id===pid);
  if(!p)return;
  const removed=(p.bookings||[]).find(b=>b.id===bid);
  if(!removed)return;
  const prevAvg=p.avgRentalDays;
  p.bookings=(p.bookings||[]).filter(b=>b.id!==bid);
  const avg=calcAvgFromBookings(pid);
  if(avg!==null)p.avgRentalDays=avg;
  save();renderView();
  toast('Booking deleted.','info',{duration:5000,action:'Undo',onAction:()=>{
    const pp=state.properties.find(x=>x.id===pid);
    if(!pp)return;
    if(!pp.bookings)pp.bookings=[];
    pp.bookings.push(removed);
    const a=calcAvgFromBookings(pid);
    pp.avgRentalDays = (a!==null?a:prevAvg);
    save();renderView();toast('Booking restored.','success');
  }});
}

// ── MP TESTS ──
function vMP(){
  const sps=state.properties.filter(p=>p.type==='STR');
  const ltrs=state.properties.filter(p=>p.type==='LTR');
  return`
<div class="ph"><h1 class="pg-title">Material Participation Tests</h1><div class="pg-sub">All 7 tests under Temp. Reg. §1.469-5T evaluated per STR property. Passing any one test qualifies you.</div></div>

<div style="background:#F0FDFA;border:1px solid #CCFBF1;border-left:4px solid #14B8A6;border-radius:12px;padding:20px 22px;margin-bottom:20px;">
  <div style="font-size:13px;font-weight:800;color:#0D1F3C;margin-bottom:10px;">📊 How this page works</div>
<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:10px;padding:11px 14px;margin-bottom:16px;font-size:12px;color:#1E40AF;line-height:1.7;">
  📖 <strong>Key Terms:</strong> <strong>SPA</strong> = Significant Participation Activity (100–499 hrs in a single activity per §1.469-5T(a)(4)). <strong>PSA</strong> = Personal Service Activity (relevant to Test 6 — does not apply to most STRs; applies to medical, law, engineering, etc.). <strong>MP</strong> = Material Participation.
</div>
  <div style="font-size:13px;color:#334155;line-height:1.8;">
    The results on this page are calculated automatically from two sources:
    <br><strong>1. Your logged hours</strong> — every time entry you log for an STR property counts toward your participation hours for that property.
    <br><strong>2. "Other Participants' Hours"</strong> — the number you entered on each property card for your cleaner, co-host, or property manager. This is used for Tests 3 and 7.
  </div>
  <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 1</span> <span style="color:#64748B;">Your hours &gt; 500</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 2</span> <span style="color:#64748B;">You = only participant</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 3</span> <span style="color:#64748B;">Your hours &gt; 100 AND ≥ others' hours</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 4</span> <span style="color:#64748B;">Each activity 100–499 hrs (SPA) + all SPAs aggregate &gt; 500 hrs</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 5</span> <span style="color:#64748B;">Qualified in 5 of last 10 years</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;"><span style="font-weight:700;color:#0D1F3C;">Test 6</span> <span style="color:#64748B;">Qualified 3 prior years (PSA — does not apply to most STRs)</span></div>
    <div style="background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #CCFBF1;grid-column:1/-1;"><span style="font-weight:700;color:#0D1F3C;">Test 7</span> <span style="color:#64748B;">Regular, continuous & substantial basis (facts & circumstances)</span></div>
  </div>
  <div style="margin-top:12px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:10px 14px;font-size:12px;color:#92400E;">
    ⚠️ <strong>Tests 5 and 6</strong> require historical data across multiple tax years. RepsRecord evaluates these based only on data logged within the app. You may manually override test results below if you have prior year documentation. Always consult your tax professional for final determination.
  </div>
</div>

${sps.length>0?`
<h2 class="sec-lbl" style="margin-bottom:12px;">🏖 Short-Term Rental Properties — Material Participation Tests</h2>
${sps.map(p=>{
  const ph=pH(p.id),ts=mpT(p.id),any=ts.some(t=>t.met);
  const gate=strGate(p),q=strQualifies(p);
  const badgeSpan=q==='yes'
    ?'<span class="badge b-met" style="font-size:12px;padding:5px 13px;">✅ Qualifies (≤7-day + MP)</span>'
    :any
      ?'<span class="badge" style="font-size:12px;padding:5px 13px;background:#FEF3C7;color:#92400E;">'+(q==='conditional'?'⚠ MP met · 8–30-day avg':'⚠ MP met · period gate not met')+'</span>'
      :'<span class="badge b-no" style="font-size:12px;padding:5px 13px;">❌ Does Not Currently Qualify</span>';
  const gateMsg=any&&q!=='yes'?(gate==='services'
      ?'Average rental period is 8–30 days. This property is non-rental <strong>only if significant personal services are provided</strong> (Reg. §1.469-1T(e)(3)(ii)(B)) — material participation alone is not enough.'
      :gate==='rental'
      ?'Average rental period exceeds 30 days, so the STR exception does not apply. These losses need REPS for non-passive treatment.'
      :'Set this property\u2019s average rental period (use the Booking Log) to confirm the ≤7-day STR exception — material participation alone does not make losses non-passive.'):'';
  return`<div class="card card-mb">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <div style="font-size:16px;font-weight:800;color:#0D1F3C;">${esc(p.name)}${p.avgRentalDays?` <span style="font-size:11px;font-weight:600;color:${gate==='exempt'?'#10B981':'#F59E0B'};">· Avg ${p.avgRentalDays}d</span>`:''}</div>
        <div style="font-size:12px;color:#64748B;margin-top:2px;">Your hours: <strong>${Math.round(ph.owner)}</strong>${state.settings.spouseEnabled?` · ${state.settings.spouseName||'Spouse'}: <strong>${Math.round(ph.spouse)}</strong>`:''}${p.otherHours>0?` · Others: <strong>${p.otherHours}</strong>`:''}</div>
      </div>
      ${badgeSpan}
    </div>
    ${gateMsg?`<div style="background:#FFF7ED;border:1px solid #FDE68A;border-radius:8px;padding:8px 12px;font-size:11.5px;color:#92400E;line-height:1.55;margin-bottom:14px;">${gateMsg}</div>`:''}
    ${ts.map(t=>`
    <div class="mp-row">
      <div class="mp-num ${t.met?'met':'unm'}">${t.met?'✓':t.id}</div>
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="mp-name">${t.name} — ${t.label}</div>
          <span style="font-size:10px;color:#94A3B8;font-family:ui-monospace,monospace;padding:1px 6px;background:#F0FDFA;border-radius:4px;">${t.cite}</span>
          ${t.met?(t.id===7?'<span style="font-size:11px;font-weight:700;color:#B45309;">✓ Likely met</span>':'<span style="font-size:11px;font-weight:700;color:#10B981;">✓ Met</span>'):''}
        </div>
        <div class="mp-desc">${t.desc}</div>
        ${!t.auto?`<label class="mp-man"><input type="checkbox" ${t.met?'checked':''} data-chg="togMP" data-id="${p.id}" data-tid="${t.id}"/><span>Mark as met for ${activeYear} — requires supporting documentation</span></label>`:''}
        ${t.auto&&!t.met&&t.id===3?`<div style="font-size:11px;color:#0F766E;margin-top:6px;">Need ${Math.max(0,Math.ceil(100-(ph.owner+(ph.spouse||0))+0.01))} more hours${(()=>{const mo=(state.settings.spouseHoursPolicy||'majority')==='conservative'?Math.max(ph.spouse||0,p.otherHours||0):(p.otherHours||0);return mo>0?' & must equal or exceed other participants ('+Math.round(mo)+' hrs)':'';})()}</div>`:''}
        ${t.auto&&!t.met&&t.id===1?`<div style="font-size:11px;color:#0F766E;margin-top:6px;">Need ${Math.max(0,Math.ceil(500-(ph.owner+(ph.spouse||0))+0.01))} more hours for this property</div>`:''}
        ${t.auto&&t.met&&t.id===7?`<div style="font-size:11px;color:#B45309;margin-top:6px;background:#FFF7ED;border:1px solid #FDE68A;border-radius:6px;padding:6px 9px;line-height:1.5;">⚠ Facts-and-circumstances test — the app checks only your hours. Confirm you participate on a regular, continuous, and substantial basis and that <strong>no other person is compensated to manage</strong> this property (§1.469-5T(b)(2)(ii)).</div>`:''}
        ${t.auto&&!t.met&&t.id===7&&p.otherHoursCompensated&&(p.otherHours||0)>0?`<div style="font-size:11px;color:#991B1B;margin-top:6px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:6px 9px;line-height:1.5;">⛔ Test 7 unavailable: a paid co-host / property manager (${Math.round(p.otherHours)} hrs) is compensated to manage this property, which disqualifies the facts-and-circumstances test under §1.469-5T(b)(2)(ii). Use another test to qualify, or remove the paid-management flag if it no longer applies.</div>`:''}
      </div>
    </div>`).join('')}
  </div>`;}).join('')}`:''}

${ltrs.length>0?`
<h2 class="sec-lbl" style="margin-bottom:12px;margin-top:24px;">🏡 Long-Term Rental Properties — REPS Portfolio Tracking</h2>
<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-left:4px solid #38BDF8;border-radius:12px;padding:16px 20px;margin-bottom:16px;font-size:13px;color:#1D4ED8;">
  ℹ️ Long-term rental properties do not use per-property MP tests. Instead, your hours across all LTR properties are pooled toward your <strong>750-hour REPS qualification</strong> and the <strong>50% personal services test</strong>. Track your progress on the Dashboard.
</div>
${ltrs.map(p=>{
  const hrs=yearEntries().filter(e=>e.propertyId===p.id&&!e.isSpouse).reduce((s,e)=>s+(e.hours||0),0);
  return`<div class="card card-mb" style="display:flex;justify-content:space-between;align-items:center;">
    <div>
      <div style="font-size:15px;font-weight:800;color:#0D1F3C;">${esc(p.name)}</div>
      <div style="font-size:12px;color:#64748B;margin-top:3px;">${esc(p.address)||'No address'}</div>
      <span class="badge b-amber" style="margin-top:6px;display:inline-block;">LTR</span>
    </div>
    <div style="text-align:right;">
      <div style="font-size:28px;font-weight:900;color:#0D1F3C;">${Math.round(hrs)}<span style="font-size:13px;font-weight:400;color:#64748B;"> hrs</span></div>
      <div style="font-size:11px;color:#64748B;">counts toward REPS 750</div>
    </div>
  </div>`;}).join('')}`:''}

${state.properties.length===0?`<div class="empty"><div class="empty-ic">✅</div><div class="empty-tx">Add properties first to evaluate material participation. <a href="#" data-act="nav" data-target="properties" data-prevent="1" style="color:#14B8A6;text-decoration:none;font-weight:600;">Add a property →</a></div></div>`:''}`;
}

function togMP(pid,tid,val){if(!state.manualMP)state.manualMP={};if(!state.manualMP[pid])state.manualMP[pid]={};state.manualMP[pid][tid]=val;save();renderView();}

// ── REPORTS ──
function vReports(){
  const r=calcREPS();
  const ye=yearEntries();
  const tot=ye.reduce((s,e)=>s+(e.hours||0),0);
  const byCat={};
  ye.forEach(e=>{const k=`${e.trackType}|${e.category}`;if(!byCat[k])byCat[k]={trackType:e.trackType,category:e.category,hours:0,count:0};byCat[k].hours+=e.hours||0;byCat[k].count++;});
  const cats=Object.values(byCat).sort((a,b)=>b.hours-a.hours);
  const sorted=[...ye].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const sps=state.properties.filter(p=>p.type==='STR');
  // Pass 7 (audit-report clarity): surface STR hours that are logged but NOT included in the
  // REPS 750-hr figure, so the "RE hours logged" summary and the "Hours by Activity Category"
  // total reconcile for a reader. Excluded = all non-spouse STR-type hours minus those that
  // actually counted toward rh (only 'yes'-qualifying STR properties count, and only when the
  // includeSTRinREPS setting is on).
  const _inc=state.settings.includeSTRinREPS===true;
  const _strYesIds=_inc?new Set(state.properties.filter(p=>p.type==='STR'&&strQualifies(p)==='yes').map(p=>p.id)):new Set();
  const _strHrsTotal=ye.filter(e=>!e.isSpouse&&e.trackType==='STR').reduce((s,e)=>s+(e.hours||0),0);
  const _strHrsCounted=_inc?ye.filter(e=>!e.isSpouse&&e.trackType==='STR'&&_strYesIds.has(e.propertyId)).reduce((s,e)=>s+(e.hours||0),0):0;
  const strHrsExcluded=Math.max(0,_strHrsTotal-_strHrsCounted);
  return`
<div class="ph">
  <div class="ph-row">
    <div><h1 class="pg-title">Audit Report <span style='font-size:13px;font-weight:400;color:#64748B;'>/ Contemporaneous Activity Log</span></h1><div class="pg-sub">IRC §469(c)(7) REPS &amp; Temp. Reg. §1.469-5T STR — Tax Year ${activeYear} — Prepared for IRS substantiation</div></div>
    <div class="top-acts" style="display:flex;gap:8px;">
      <button class="btn btn-outline btn-sm" data-act="printPage">🖨 Print</button>
      <button class="btn btn-teal btn-sm" data-act="exportXLSX">📥 Export to Excel</button>
    </div>
  </div>
</div>
<div class="card card-mb" style="background:${r.ok?'#ECFDF5':'#F0FDFA'};border-color:${r.ok?'#6EE7B7':'#99F6E4'};">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:14px;">REPS Qualification Summary — IRC §469(c)(7)</div>
  <div class="g3">
    <div class="rstat"><div class="rstat-num">${Math.round(r.rh)}</div><div class="rstat-lbl">RE hours logged</div><div class="rstat-req">Required: > 750 hrs</div><span class="badge ${r.m750?'b-met':'b-no'}" style="margin-top:6px;display:inline-block;">${r.m750?'MET ✓':'NOT MET'}</span></div>
    <div class="rstat"><div class="rstat-num">${Math.round(r.pct)}%</div><div class="rstat-lbl">% of personal services</div><div class="rstat-req">Required: > 50%</div><span class="badge ${r.m50?'b-met':'b-no'}" style="margin-top:6px;display:inline-block;${r.incomplete50?'background:#FEF3C7;color:#92400E;':''}">${r.incomplete50?'UNVERIFIED':r.m50?'MET ✓':'NOT MET'}</span></div>
    <div class="rstat"><div class="rstat-num" style="color:${r.ok?'#10B981':r.incomplete50?'#F59E0B':'#EF4444'}">${r.ok?'YES':r.incomplete50?'PENDING':'NO'}</div><div class="rstat-lbl">REPS qualified</div><div class="rstat-req">Both tests required</div><span class="badge ${r.ok?'b-met':'b-no'}" style="margin-top:6px;display:inline-block;${r.incomplete50?'background:#FEF3C7;color:#92400E;':''}">${r.ok?'QUALIFIED':r.incomplete50?'VERIFY NON-RE HRS':'NOT YET'}</span></div>
  </div>
  ${strHrsExcluded>0?`<div style="margin-top:12px;font-size:11.5px;color:#92400E;background:#FFF7ED;border:1px solid #FDE68A;border-radius:8px;padding:9px 13px;line-height:1.6;">ℹ️ ${Math.round(strHrsExcluded)} short-term-rental hour${Math.round(strHrsExcluded)===1?'':'s'} logged this year ${Math.round(strHrsExcluded)===1?'is':'are'} tracked separately under the Short-Term Rental strategy below and ${Math.round(strHrsExcluded)===1?'is':'are'} <strong>not</strong> part of the ${Math.round(r.rh)} REPS hours above — ${_inc?'those properties have not met the ≤7-day average rental period exception (Reg. §1.469-1T(e)(3)(ii)(A)), so their hours do not count toward the §469(c)(7)(B)(ii) 750-hour test':'the “Include STR hours in REPS 750-hr total” setting is off'}. Total logged hours shown below may therefore exceed the REPS figure.</div>`:''}
</div>
${sps.length?`
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:14px;">STR Material Participation — Temp. Reg. §1.469-5T</div>
  ${sps.map(p=>{const ph=pH(p.id),ts=mpT(p.id),any=ts.some(t=>t.met),best=ts.find(t=>t.met),q=strQualifies(p);const bl=best?best.label:'';const badgeSpan=q==='yes'?`<span class="badge b-met">✓ Qualifies — MP via ${bl}</span>`:any?`<span class="badge" style="background:#FEF3C7;color:#92400E;">${q==='conditional'?'⚠ MP via '+bl+' · 8–30-day avg (needs significant services)':'⚠ MP via '+bl+' · period gate not met'}</span>`:'<span class="badge b-no">Does Not Qualify</span>';return`
  <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:.5px solid #F0FDFA;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div><strong>${esc(p.name)}</strong>${p.address?` <span style="font-size:11px;color:#64748B;">· ${esc(p.address)}</span>`:''} ${p.avgRentalDays?`<span style="font-size:11px;color:${p.avgRentalDays<=7?'#10B981':'#F59E0B'};">· Avg ${p.avgRentalDays}d</span>`:''}</div>
      ${badgeSpan}
    </div>
    <div style="font-size:12px;color:#64748B;margin-bottom:8px;">Your hours: <strong style="color:#0D1F3C">${Math.round(ph.owner)}</strong>${state.settings.spouseEnabled?` · ${state.settings.spouseName||'Spouse'}: <strong>${Math.round(ph.spouse)}</strong>`:''}</div>
    <div class="tcs">${ts.map(t=>`<span class="tc ${t.met?'tc-y':'tc-n'}">${t.name} — ${t.label}${t.met?' ✓':''}</span>`).join('')}</div>
  </div>`;}).join('')}
</div>`:''}
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:14px;">Hours by Activity Category</div>
  <table><thead><tr><th>Type</th><th>Activity</th><th>Entries</th><th>Total Hours</th></tr></thead><tbody>
  ${cats.map(c=>`<tr><td><span class="tb tb-${c.trackType==='STR'?'s':'r'}">${c.trackType}</span></td><td>${esc(c.category)}</td><td style="color:#64748B;">${c.count}</td><td><strong>${fmtH(c.hours)}</strong></td></tr>`).join('')}
  <tr style="border-top:1.5px solid #CCFBF1;"><td colspan="3"><strong>All logged hours${state.settings.spouseEnabled?' (incl. spouse)':''}</strong></td><td><strong style="font-size:15px;">${fmtH(tot)}</strong></td></tr>
  </tbody></table>
</div>
<div class="card">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:14px;">Complete Time Log — ${sorted.length} entries</div>
  ${sorted.length===0?`<div class="empty" style="padding:20px 0;"><div class="empty-tx">No entries logged yet.</div></div>`:`
  <table style="table-layout:fixed;">
    <thead><tr><th style="width:11%">Date</th><th style="width:17%">Property</th><th style="width:8%">Type</th><th style="width:25%">Activity</th><th style="width:8%">Hours</th><th style="width:31%">Notes</th></tr></thead>
    <tbody>${sorted.map(e=>{const pr=state.properties.find(p=>p.id===e.propertyId);return`<tr>
      <td style="font-size:11px;color:#64748B;">${e.date}</td>
      <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">${pr?.name||'General'}</td>
      <td><span class="tb tb-${e.trackType==='STR'?'s':'r'}">${e.trackType}</span>${e.isSpouse?'<span class="tb tb-sp">SP</span>':''}</td>
      <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">${esc(e.category)}</td>
      <td><strong>${fmtH(e.hours)}</strong></td>
      <td style="font-size:11px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.notes||'—')}</td>
    </tr>`;}).join('')}</tbody>
  </table>`}
</div>`;
}

// ── SETTINGS ──
// CRITICAL FIX 3: Spouse disclosure now shown BEFORE the checkbox, always visible,
// with clear statement that spouse hours do NOT count toward the taxpayer's REPS tests.
function vSettings(){
  const s=state.settings;
  return`
<div class="ph"><h1 class="pg-title">Settings</h1><div class="pg-sub">Configure your tax situation for accurate qualification tracking.</div></div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:4px;">Subscription &amp; Billing</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:14px;line-height:1.6;">Update your payment method, view invoices, or cancel your subscription. Opens a secure Stripe page in a new tab.</div>
  <a href="https://billing.stripe.com/p/login/bJedR19mL8bK7rY3nuebu00" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#0D1F3C;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;">Manage subscription</a>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:4px;">50% Personal Services Test — IRC §469(c)(7)(B)(i)</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:14px;line-height:1.6;">Enter your total hours in non-real-estate activities this year (W-2, other businesses). Used to calculate whether RE hours exceed 50% of ALL personal services.</div>
  <div class="field"><label class="fl">Non-Real Estate Hours This Year</label><input type="number" min="0" step="1" value="${s.nonREPSHours||''}" placeholder="0" data-chg="setNum" data-key="nonREPSHours"/><div class="hint">Enter your hours in W-2 jobs, other businesses, or any non-real-estate activity. Example: a full-time W-2 job = ~2,080 hrs/yr (52 weeks × 40 hrs). Only YOUR hours count — not a spouse's W-2.</div></div>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:10px;">Spouse / Co-Participant Tracking</div>
  <div style="background:#FFF7ED;border:1px solid #FDE68A;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;color:#92400E;line-height:1.7;">
    <strong>⚠ Important — REPS qualification is individual:</strong> A spouse's hours do <strong>not</strong> count toward <em>your</em> 750-hour test or 50% personal services test (IRC §469(c)(7)(B)). These are tested per-taxpayer, not jointly.
    <br><br>
    Spouse hours <strong>do</strong> apply to per-property Material Participation testing under §469(h)(5) and Temp. Reg. §1.469-5T(f)(3):
    <ul style="margin-top:6px;padding-left:16px;line-height:1.9;">
      <li>Test 1 (500 hrs) — spouse hours combine with yours</li>
      <li>Tests 5 &amp; 6 — prior-year history tests apply jointly</li>
      <li>Tests 3 &amp; 7 — <strong>majority view:</strong> spouse hours combine with yours and are excluded from "any other individual"; <strong>conservative view</strong> (used by some practitioners): spouse may be treated as a third-party participant. Discuss with your CPA — your position should align with your filing status.</li>
    </ul>
    <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #FCD34D;">One nuance on the 750-hour test: spouse hours are <strong>never added</strong> to your 750 total, but under §469(h)(5) they can help establish your <em>material participation</em> in a real property trade or business — and the 750 counts only your hours in businesses in which you materially participate. So a spouse's hours can indirectly help <em>qualify the activity</em> whose hours you then count, without ever counting toward the 750 themselves.</div>
    <span style="color:#B45309;font-weight:600;display:block;margin-top:8px;">Do not rely on spouse hours to help you qualify for REPS qualification itself.</span>
  </div>
  <label class="tog-row"><input type="checkbox" ${s.spouseEnabled?'checked':''} data-chg="setBoolRender" data-key="spouseEnabled"/><span class="tog-lbl">Enable spouse hour tracking</span></label>
  ${s.spouseEnabled?`<div class="field"><label class="fl">Spouse Name</label><input value="${esc(s.spouseName||'')}" placeholder="First name or initials" data-chg="setStr" data-key="spouseName"/></div>`:''}
  ${s.spouseEnabled?`
  <div class="field">
    <label class="fl">Tests 3 &amp; 7 — Spouse Hours Treatment</label>
    <select data-chg="setStrRenderSB" data-key="spouseHoursPolicy">
      <option value="majority" ${(s.spouseHoursPolicy||'majority')==='majority'?'selected':''}>Majority view — spouse hours combine with yours per §469(h)(5) (regulatory position · default)</option>
      <option value="conservative" ${s.spouseHoursPolicy==='conservative'?'selected':''}>Conservative — spouse also counted as a competing participant in Tests 3 &amp; 7 (defensive)</option>
    </select>
    <div class="hint">
      <strong>How spouse hours are counted (both views):</strong> per IRC §469(h)(5) and §1.469-5T(f)(3), a spouse's participation is always added to your own hours for every test — including Test 1's 500-hour floor and the 100-hour floors of Tests 3 &amp; 7. The two views differ only on the "more than any other individual" comparison in Tests 3 &amp; 7.<br>
      <strong>Majority view (default):</strong> the spouse is treated as you, so spouse hours are not also counted on the "other individual" side. This is the dominant practitioner reading of §469(h)(5).<br>
      <strong>Conservative view:</strong> the spouse's hours are additionally compared against you on the others' side of Tests 3 &amp; 7 — a more defensive position. Confirm the position you take with your CPA; it should align with your filing status.<br>
      <strong>Note — unsettled:</strong> no case or ruling squarely resolves whether a spouse is "any other individual" for Tests 3 &amp; 7. Both readings appear in practice, so this remains a judgment call for you and your CPA.
    </div>
  </div>`:''}
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">§469(c)(7)(A) Grouping Election</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:12px;line-height:1.6;">If you have multiple LTR properties, this election combines all your hours into one pool — making material participation easier to achieve. <strong>Most new investors should consult their CPA before enabling this.</strong> Cannot be easily revoked once filed.</div>
  <label class="tog-row"><input type="checkbox" ${s.groupingElection?'checked':''} data-chg="setBool" data-key="groupingElection"/><span class="tog-lbl">Grouping election filed for ${activeYear}</span></label>
  <div class="hint" style="margin-top:2px;padding:8px 10px;background:#EFF6FF;border-radius:6px;border:.5px solid #BFDBFE;color:#1E40AF;">⚠ This tracks your election status only. The actual grouping election must be attached to your timely filed original tax return per Treas. Reg. §1.469-9(g). Note: The §469(c)(7)(A) election and the §1.469-9 grouping election are related but distinct — your tax professional should confirm which applies. If you missed the filing deadline, see Rev. Proc. 2011-34 for potential relief. Consult your tax professional before filing.</div>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">Count STR Hours Toward REPS 750-Hr Test</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:12px;line-height:1.6;">STR hours count toward the 750-hr test only if you materially participate in each STR property as a trade or business (not merely as passive owner). Consult your tax advisor for your specific situation.</div>
  <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:11px 14px;margin-bottom:12px;font-size:12px;color:#991B1B;line-height:1.7;">
    ⚠ <strong>Important — adverse case law:</strong> The Tax Court has held in <em>Bailey v. Comm'r</em>, T.C. Memo 2001-296 and <em>Bailey v. Comm'r</em>, T.C. Summary 2011-22 that hours spent on short-term rentals (≤7-day average rental period) do <strong>not</strong> count toward the §469(c)(7)(B)(ii) 750-hour REPS test, because STRs are not "rental" activities under §469. Under that reading, this toggle should be <strong>off</strong>. Some practitioners take the contrary view that STR hours qualify as services in a real property trade or business under §469(c)(7)(C). Discuss with your CPA before relying on this setting.
  </div>
  <label class="tog-row"><input type="checkbox" ${s.includeSTRinREPS===true?'checked':''} data-chg="setBool" data-key="includeSTRinREPS"/><span class="tog-lbl">Include STR hours in REPS 750-hr total</span></label>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">Suspended Passive Activity Losses (PAL Carryforwards)</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:10px;line-height:1.7;">RepsRecord tracks your current-year qualification status. It does not track prior-year suspended PAL carryforwards, which are a separate but important consideration.</div>
  <div style="background:#F0FDFA;border:.5px solid #CCFBF1;border-radius:8px;padding:12px 14px;font-size:12px;color:#0F766E;line-height:1.7;">
    <strong>What this means for you:</strong> If your rental properties generated passive losses in years when you were not REPS-qualified, those losses are suspended under IRC §469(b). Qualifying as a REPS taxpayer in a <em>later</em> year does not automatically free prior-year suspended PALs — they remain suspended until the activity is disposed of or other triggering events occur. Your tax professional should review your carryforward schedule when you first qualify.
  </div>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">Net Investment Income Tax (NIIT) — IRC §1411</div>
  <div style="font-size:12px;color:#64748B;line-height:1.7;margin-bottom:10px;">REPS qualification does <strong>not</strong> automatically remove the 3.8% Net Investment Income Tax on rental income.</div>
  <div style="background:#F0FDFA;border:.5px solid #CCFBF1;border-radius:8px;padding:12px 14px;font-size:12px;color:#0F766E;line-height:1.7;">
    <strong>Why this matters:</strong> §1411 has its own trade-or-business and material-participation analysis. Rental income avoids NIIT only when (1) the rental activity rises to a §162 trade or business AND (2) you materially participate. REPS status alone — without the underlying trade-or-business posture — may not be enough. The position depends on facts (services provided, scale of operations, hours, etc.). Discuss the §1411 analysis with your CPA separately from your §469 analysis.
  </div>
  <div class="field" style="margin-top:14px;"><label class="fl">Filing status</label>
    <select data-chg="setStrRender" data-key="filingStatus">
      ${Object.keys(FILING_LABELS).map(k=>`<option value="${k}" ${(s.filingStatus||'MFJ')===k?'selected':''}>${FILING_LABELS[k]}</option>`).join('')}
    </select>
    <div class="hint">Your §1411 MAGI threshold: <strong>$${(NIIT_THRESHOLDS[s.filingStatus||'MFJ']||250000).toLocaleString()}</strong>. The 3.8% NIIT applies to the lesser of net investment income or MAGI above this threshold. These thresholds are fixed by statute and are <strong>not</strong> adjusted for inflation. This figure is informational only — RepsRecord does not compute your NIIT.</div>
  </div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">§280A Personal-Use Limitation</div>
  <div style="font-size:12px;color:#64748B;line-height:1.7;margin-bottom:10px;">If you use a dwelling unit as a residence — defined as personal use exceeding the greater of <strong>14 days</strong> or <strong>10% of total rental days</strong> — IRC §280A limits the deductions you can claim against the rental income. Net losses may be disallowed entirely, regardless of REPS or material participation status.</div>
  <div class="field"><label class="fl">Total personal use days this year (across all STR/LTR properties)</label><input type="number" min="0" step="1" value="${s.personalUseDays||''}" placeholder="0" data-chg="setNum" data-key="personalUseDays"/><div class="hint">Includes days used by you, family members (spouse, kids, siblings, parents, grandparents), or anyone paying less than fair rental value. A property meeting the 14-day-or-10% threshold becomes a "residence" under §280A and loss deductibility is capped at gross rental income. Consult your CPA — §280A interacts with §469 in complex ways.</div></div>
</div>
<div class="card card-mb">
  <div style="font-size:14px;font-weight:800;color:#0D1F3C;margin-bottom:6px;">Community Property States</div>
  <div style="font-size:12px;color:#64748B;line-height:1.7;">If you are married and reside in a community property state — Arizona, California, Idaho, Louisiana, Nevada, New Mexico, Texas, Washington, or Wisconsin — your state's income and property rules may interact with the REPS individual-testing requirements in non-obvious ways. The IRC §469(c)(7) 750-hour and 50% tests are applied per-taxpayer regardless of community property treatment. Consult your tax professional about how your state's rules affect your specific situation before relying on RepsRecord's calculations.</div>
</div>
<div class="card" style="background:#FEF2F2;border-color:#FECACA;">
  <div style="font-size:14px;font-weight:800;color:#991B1B;margin-bottom:6px;">Reset All Data</div>
  <div style="font-size:12px;color:#64748B;margin-bottom:12px;">Permanently deletes all entries, properties, and settings.</div>
  <button class="btn btn-danger" data-act="resetAll">Reset Everything</button>
  <div class="hint" style="margin-top:8px;color:#EF4444;">⚠ A second confirmation will be required. This action cannot be undone.</div>
</div>`;
}

function setSetting(k,v){state.settings[k]=v;save();updateSB();}
async function resetAll(){
  const ok=await dlgConfirm({title:'Reset all data?',body:'This permanently deletes all entries, properties, and settings. This cannot be undone.',confirmLabel:'Continue',danger:true});
  if(!ok)return;
  const code=await dlgPrompt({title:'Confirm reset',body:'Type RESET to permanently erase all data.',placeholder:'RESET',confirmLabel:'Reset everything',danger:true,expectedText:'RESET'});
  if(code===null)return;
  state={settings:{nonREPSHours:0,spouseEnabled:false,spouseName:'',groupingElection:false,includeSTRinREPS:false,personalUseDays:0,filingStatus:'MFJ',spouseHoursPolicy:'majority'},properties:[],entries:[],manualMP:{}};
  save();renderView();
  toast('All data reset.','success');
}


// ── LTR RULES ──
function vLTR(){
  return`
<div class="ph"><h1 class="pg-title">REPS Rules — Real Estate Professional Status</h1><div class="pg-sub">IRC §469(c)(7) · Two-part qualification test for non-passive rental losses</div></div>
<div class="banner bn-teal" style="margin-bottom:16px;"><div class="bn-ic">⚖️</div><div><div class="bn-title">Why REPS matters</div><div class="bn-sub">Without REPS, rental losses are passive and can only offset passive income. With REPS, rental losses become non-passive and can offset W-2, business, and other active income — potentially eliminating unlimited tax liability.</div></div></div>

<h2 class="sec-lbl">Test 1 of 2 — More Than 750 Hours Required</h2>
<div class="card card-mb">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;"><div style="font-size:15px;font-weight:800;color:#0D1F3C;">IRC §469(c)(7)(B)(ii)</div><span class="badge b-warn" style="font-size:12px;padding:5px 13px;">Must exceed 750 hours</span></div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:14px;">You must perform more than 750 hours of services during the tax year in real property trades or businesses in which you materially participate. Hours from any qualifying real property trade or business count — not just rentals.</div>
  <h2 class="sec-lbl">Qualifying real property trades or businesses — <span style="text-transform:none;font-family:ui-monospace,monospace;letter-spacing:0;">§469(c)(7)(C)</span></h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    ${['Real property development','Real property redevelopment','Real property construction','Real property reconstruction','Real property acquisition','Real property conversion','Rental of real property','Operation of real property','Management of real property','Leasing of real property','Brokerage trade or business'].map(a=>`<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#F0FDFA;border-radius:8px;font-size:12px;color:#0D1F3C;"><span style="color:#14B8A6;font-weight:700;">✓</span>${a}</div>`).join('')}
  </div>
  <div style="font-size:11px;color:#64748B;line-height:1.6;margin-top:10px;padding:10px 12px;background:#F8FAFC;border-radius:8px;border:.5px solid #E2E8F0;"><strong>Note:</strong> §469(c)(7)(C) lists eleven real property trades or businesses. Sale activities related to owned real property are generally treated under <em>operation</em>, <em>management</em>, or <em>brokerage</em> rather than as a separate statutory category. Licensed brokerage hours follow §469(c)(7)(D)(ii) — see the 5% ownership rule below if you work as a W-2 employee.</div>
  <div style="background:#FEF3C7;border:.5px solid #FCD34D;border-radius:10px;padding:14px;margin-top:14px;">
    <div style="font-size:12px;font-weight:700;color:#92400E;margin-bottom:6px;">⚠ 5% Ownership Rule — §469(c)(7)(D)(ii)</div>
    <div style="font-size:12px;color:#0D1F3C;line-height:1.7;">If you perform services in a real property trade or business <strong>as an employee</strong>, those hours do <strong>not</strong> count toward the 750-hour test unless you own <strong>5% or more</strong> of the entity. This is the most common disqualifier for licensed real estate agents working under a brokerage they don't own.</div>
  </div>
</div>

<h2 class="sec-lbl">Test 2 of 2 — 50% Personal Services Test</h2>
<div class="card card-mb">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;"><div style="font-size:15px;font-weight:800;color:#0D1F3C;">IRC §469(c)(7)(B)(i)</div><span class="badge b-warn" style="font-size:12px;padding:5px 13px;">&gt; 50% of all services must be RE</span></div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:14px;">More than half of all personal services performed in all trades or businesses during the year must be in real property trades or businesses in which you materially participate. Your RE hours must outnumber your non-RE hours.</div>
  <div style="background:#CFFAFE;border:.5px solid #99F6E4;border-radius:10px;padding:14px;">
    <div style="font-size:12px;font-weight:700;color:#0E7490;margin-bottom:6px;">💡 W-2 Employee Trap</div>
    <div style="font-size:12px;color:#0D1F3C;line-height:1.7;">If you have a full-time W-2 job (~2,000 hrs/yr), your RE hours must exceed 2,000+ to pass the 50% test. A spouse's W-2 does NOT count against you when filing jointly — only YOUR personal services are measured. Log your non-RE hours in Settings to track this accurately.</div>
  </div>
</div>

<h2 class="sec-lbl">Material Participation in Each Rental Activity</h2>
<div class="card card-mb">
  <div style="font-size:15px;font-weight:800;color:#0D1F3C;margin-bottom:8px;">IRC §469(c)(7)(A) + Temp. Reg. §1.469-5T</div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:14px;">Passing both REPS tests is not enough on its own. You must also materially participate in each rental activity individually — or file a grouping election. Rental properties where you don't materially participate remain passive even with REPS.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    ${[['Test 1','More than 500 hours in the activity'],['Test 2','Substantially all participation'],['Test 3','More than 100 hours, not less than any other individual'],['Test 4','SPA aggregate: >100 hrs each (trade/business only), >500 hrs total'],['Test 5','5 of the last 10 years'],['Test 6','3 prior years (personal service activity — rarely applies to rentals)'],['Test 7','Facts & Circumstances: >100 hrs required, no paid manager, no one else does more management (§1.469-5T(b)(2)(ii)–(iii))']].map(([t,d])=>`<div style="padding:10px 12px;background:#F0FDFA;border-radius:8px;border:.5px solid #CCFBF1;"><div style="font-size:11px;font-weight:700;color:#14B8A6;margin-bottom:3px;">${t}</div><div style="font-size:12px;color:#0D1F3C;">${d}</div></div>`).join('')}
  </div>
</div>

<h2 class="sec-lbl"><span style="text-transform:none;font-family:ui-monospace,monospace;letter-spacing:0;">§469(c)(7)(A)</span> Grouping Election</h2>
<div class="card card-mb">
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:12px;">A REPS taxpayer may elect to treat all rental real estate interests as a single activity. This makes material participation much easier — all hours across all properties are combined. Must be filed on a timely filed return.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
    <div style="padding:12px;background:#ECFDF5;border-radius:10px;border:.5px solid #6EE7B7;"><div style="font-size:12px;font-weight:700;color:#065F46;margin-bottom:6px;">✓ Pros</div><ul style="font-size:12px;color:#0D1F3C;line-height:1.9;padding-left:16px;"><li>Easier to meet material participation</li><li>Hours from all properties combined</li><li>Losses from one property can offset gains from others</li></ul></div>
    <div style="padding:12px;background:#FEF2F2;border-radius:10px;border:.5px solid #FECACA;"><div style="font-size:12px;font-weight:700;color:#991B1B;margin-bottom:6px;">⚠ Cons</div><ul style="font-size:12px;color:#0D1F3C;line-height:1.9;padding-left:16px;"><li>Cannot be easily revoked once made</li><li>Disposing of one property doesn't trigger full suspended loss recognition</li><li>Must be made on a timely filed original return</li><li>If you missed the deadline, see Rev. Proc. 2011-34 for potential relief</li></ul></div>
  </div>
</div>

<h2 class="sec-lbl">Top Audit Red Flags</h2>
<div class="card">
  ${[['⛔','No contemporaneous records','Courts have repeatedly rejected after-the-fact reconstructions. Log hours as they occur with specific descriptions of what was done.'],['⛔','Vague activity descriptions','"Managed property" is not enough. Record who you called, what was decided, what the outcome was, and how long it took.'],['⛔','Suspiciously round numbers','Claiming exactly 750 hours raises examiner scrutiny. Log actual time including minutes.'],['⚠','Non-RE hours not disclosed','Failing to account for W-2 or other business hours makes the 50% test unverifiable and indefensible.'],['⚠','Spouse hours mixed with taxpayer','Only the taxpayer\'s hours count for the 750-hr and 50% tests. Spouse hours are separate and must be logged distinctly.']].map(([ic,t,d])=>`<div style="display:flex;gap:12px;padding:12px 0;border-bottom:.5px solid #F0FDFA;align-items:flex-start;"><span style="font-size:18px;flex-shrink:0;">${ic}</span><div><div style="font-size:13px;font-weight:700;color:#0D1F3C;margin-bottom:3px;">${t}</div><div style="font-size:12px;color:#64748B;line-height:1.6;">${d}</div></div></div>`).join('')}
</div>`;
}

// ── STR RULES ──
function vSTR(){
  return`
<div class="ph"><h1 class="pg-title">STR Rules — Short-Term Rental Material Participation Exception</h1><div class="pg-sub">IRC §469 · Temp. Reg. §1.469-5T · How short-term rentals escape the passive loss rules</div></div>
<div class="banner bn-teal" style="margin-bottom:16px;"><div class="bn-ic">🔑</div><div><div class="bn-title">Why the STR material participation exception is powerful</div><div class="bn-sub">Short-term rentals are NOT automatically rental activities under §469 if the average rental period is 7 days or fewer. This means they are subject to material participation rules — and losses can be non-passive without REPS status, making this available to anyone.</div></div></div>

<h2 class="sec-lbl">Step 1 — Average Rental Period Test</h2>
<div class="card card-mb">
  <div style="font-size:15px;font-weight:800;color:#0D1F3C;margin-bottom:8px;">Temp. Reg. §1.469-1T(e)(3)(ii)</div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:14px;">An activity is NOT treated as a rental activity if the average period of customer use is 7 days or fewer. Calculated as total rental days ÷ number of separate rental transactions in the year.</div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">
    ${[['≤ 7 days','STR Material Participation Exception Applies','Not a rental activity — MP tests govern. Most powerful scenario. (§1.469-1T(e)(3)(ii)(A))','#ECFDF5','#6EE7B7','#065F46'],['8–30 days','May Still Qualify','Must provide significant personal services — a distinct, more complex standard than the §1.469-5T MP tests. Higher scrutiny. (§1.469-1T(e)(3)(ii)(B))','#FFFBEB','#FDE68A','#92400E'],['> 30 days','Standard Rental Rules','Subject to passive loss rules. Needs REPS for non-passive treatment.','#FEF2F2','#FECACA','#991B1B']].map(([r,t,d,bg,br,tc])=>`<div style="padding:14px;background:${bg};border-radius:10px;border:.5px solid ${br};text-align:center;"><div style="font-size:20px;font-weight:900;color:${tc};margin-bottom:4px;">${r}</div><div style="font-size:12px;font-weight:700;color:#0D1F3C;margin-bottom:6px;">${t}</div><div style="font-size:11px;color:#64748B;line-height:1.5;">${d}</div></div>`).join('')}
  </div>
  <div style="padding:11px 14px;background:#EFF6FF;border-radius:8px;border:.5px solid #BFDBFE;margin-bottom:10px;">
    <div style="font-size:12px;font-weight:700;color:#1E40AF;margin-bottom:4px;">💡 Six non-rental exceptions — §1.469-1T(e)(3)(ii)(A)–(F)</div>
    <div style="font-size:12px;color:#1E40AF;line-height:1.7;">An activity may be treated as non-rental — regardless of average rental period — if it falls into any of the six exceptions in the regulation: (A) average rental period ≤7 days; (B) average rental period 8–30 days with significant personal services; (C) extraordinary personal services provided regardless of average rental period; (D) rental incidental to a non-rental activity; (E) property available during defined business hours for non-exclusive use by customers; or (F) the taxpayer-owner's interest in the property is used in a non-rental trade-or-business activity of a partnership/S-corp/JV in which the taxpayer materially participates. A &gt;30-day arrangement satisfying any of (B)–(F) is still non-rental. Consult your tax professional.</div>
  </div>
  <div style="padding:12px 14px;background:#CFFAFE;border-radius:8px;border:.5px solid #99F6E4;">
    <div style="font-size:12px;font-weight:700;color:#0E7490;margin-bottom:4px;">📐 How to calculate average rental period</div>
    <div style="font-size:12px;color:#0D1F3C;line-height:1.7;">Total all rental days for the year, then divide by the number of separate bookings. Example: 3 bookings of 4, 5, and 6 days = 15 days ÷ 3 = <strong>5.0 day average ✓</strong>. Track each booking individually in your records — do not rely solely on platform reports.</div>
  </div>
</div>

<h2 class="sec-lbl">Step 2 — Material Participation (pass any 1 of 7 tests)</h2>
<div class="card card-mb">
  <div style="font-size:15px;font-weight:800;color:#0D1F3C;margin-bottom:8px;">Temp. Reg. §1.469-5T(a)</div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:14px;">Once a STR qualifies under the average period test, it is treated as a trade or business activity. The taxpayer must then materially participate to make losses non-passive. Pass any one of the seven tests below.</div>
  ${[['1','500 Hours','§1.469-5T(a)(1)','Participate more than 500 hours in the STR activity during the year. Per §469(h)(5) a spouse\'s hours count toward this test.','#D1FAE5','#065F46','Most straightforward but requires significant time commitment.'],['2','Substantially All','§1.469-5T(a)(2)','Your participation constitutes substantially all participation by all individuals in the activity. The regulation does not quantify "substantially all"; practitioners commonly use a 95%+ safe harbor (others combined &lt;5%).','#F0FDFA','#64748B','Difficult if you use a co-host, cleaner, or property manager.'],['3','100 Hrs + Most','§1.469-5T(a)(3)','Participate more than 100 hours AND not less than any other individual including paid staff. Per §469(h)(5) a spouse\'s hours are treated as your own — the spouse is not "another individual" for the comparison.','#D1FAE5','#065F46','Most accessible test — keep your hours above your co-host or cleaner.'],['4','SPA Aggregate','§1.469-5T(a)(4)','Activity is a Significant Participation Activity (more than 100 hrs in a trade or business activity in which you do not otherwise materially participate) and all your SPAs aggregate to more than 500 hours for the year. Rental activities cannot generate SPAs; STRs &amp; other trade-or-business activities can.','#F0FDFA','#64748B','Useful when you have multiple STRs.'],['5','5 of Last 10 Years','§1.469-5T(a)(5)','Materially participated in this activity in any 5 of the 10 immediately preceding taxable years. Need not be consecutive.','#F0FDFA','#64748B','Requires prior year documentation. Applies regardless of current year hours.'],['6','3 Prior Yrs (Service)','§1.469-5T(a)(6)','Materially participated in any 3 preceding years when the activity was a personal service activity.','#F0FDFA','#64748B','Does not apply to most STRs — rental properties are almost never personal service activities. More common for medical, law, engineering, or consulting businesses.'],['7','Facts & Circumstances','§1.469-5T(a)(7) + (b)(2)','Participate on a regular, continuous, and substantial basis. <strong>Requires more than 100 hours</strong> per §1.469-5T(b)(2)(iii). <strong>Does NOT apply</strong> if any other person is compensated for managing the activity, or if any other individual performs more management hours than you (§1.469-5T(b)(2)(ii)).','#D1FAE5','#065F46','For STR owners with a paid cleaner or co-host, this test is often unavailable — confirm with your CPA.']].map(([n,l,c,d,bg,tc,tip])=>`
  <div style="display:flex;gap:14px;padding:14px 0;border-bottom:.5px solid #F0FDFA;align-items:flex-start;">
    <div style="width:42px;height:42px;border-radius:9px;background:${bg};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:${tc};flex-shrink:0;border:.5px solid #CCFBF1;">${n}</div>
    <div style="flex:1;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
        <div style="font-size:13px;font-weight:700;color:#0D1F3C;">Test ${n} — ${l}</div>
        <span style="font-size:10px;color:#94A3B8;font-family:ui-monospace,monospace;padding:1px 6px;background:#F0FDFA;border-radius:4px;">${c}</span>
      </div>
      <div style="font-size:12px;color:#64748B;line-height:1.6;margin-bottom:4px;">${d}</div>
      <div style="font-size:11px;color:#0E7490;font-style:italic;">→ ${tip}</div>
    </div>
  </div>`).join('')}
</div>

<h2 class="sec-lbl">What hours qualify?</h2>
<div class="card card-mb">
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:12px;">Any hour genuinely spent in active management and operation of the STR counts. Courts look for real participation — not passive ownership. Document every interaction with the date, duration, and specific activity.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    ${['Guest communication & messaging','Booking & reservation management','Check-in / check-out coordination','Cleaning coordination & oversight','Listing creation & optimization','Maintenance & repair oversight','Furnishing & décor decisions','Pricing & revenue management','Financial reconciliation & accounting','Contractor coordination & scheduling','Property inspections','Travel to/from the STR property (active purpose)'].map(a=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#F0FDFA;border-radius:8px;font-size:12px;color:#0D1F3C;"><span style="color:#14B8A6;font-weight:700;">✓</span>${a}</div>`).join('')}
  </div>
</div>

<h2 class="sec-lbl">Spouse Hours & the STR Material Participation Exception</h2>
<div class="card card-mb">
  <div style="font-size:15px;font-weight:800;color:#0D1F3C;margin-bottom:8px;">Temp. Reg. §1.469-5T(f)(3)</div>
  <div style="font-size:13px;color:#64748B;line-height:1.7;margin-bottom:10px;">Spouse hours are treated differently in STR MP tests than in REPS qualification:</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
    <div style="padding:12px;background:#ECFDF5;border-radius:10px;border:.5px solid #6EE7B7;"><div style="font-size:12px;font-weight:700;color:#065F46;margin-bottom:6px;">✓ Spouse hours count for:</div><ul style="font-size:12px;color:#0D1F3C;line-height:1.9;padding-left:16px;"><li>Test 1 — combined toward 500 hr threshold</li><li>Tests 5 & 6 — prior year history tests</li></ul></div>
    <div style="padding:12px;background:#FEF3C7;border-radius:10px;border:.5px solid #FCD34D;"><div style="font-size:12px;font-weight:700;color:#92400E;margin-bottom:6px;">⚠ Practitioner-divided issue: spouse vs "any other individual" in Tests 3 &amp; 7</div><div style="font-size:12px;color:#0D1F3C;line-height:1.7;"><strong>Majority view (per §469(h)(5)):</strong> spouse hours are <em>treated as your own</em>, so the spouse is not "any other individual" for the comparison — spouse hours add to yours and are excluded from the others-side of the inequality.<br><br><strong>Conservative view:</strong> some practitioners still treat spouse hours as third-party participation when applying Test 3/7. Discuss with your CPA — the position you take should match your spouse's joint vs. separate filing status and your overall position on the return.</div></div>
  </div>
</div>

<h2 class="sec-lbl">Top STR Audit Issues</h2>
<div class="card">
  ${[['⛔','Average rental period not calculated','You must track each individual booking. Airbnb/VRBO summaries may not match the IRS calculation. Keep your own booking-level log.'],['⛔','Co-host or cleaner hours exceed yours','If a paid co-host or cleaning service logs more hours than you, Tests 3 and 7 both fail. Stay the primary participant.'],['⛔','No documentation of personal services (8–30 day avg)','For mid-range rentals, courts require evidence of specific services provided on specific dates — standard cleaning doesn\'t qualify.'],['⚠','Inconsistent treatment year to year','Treating an STR as passive one year then non-passive the next raises red flags. Pick a strategy and document it consistently.'],['⚠','Combining STR and LTR hours improperly','Each property is a separate activity unless a grouping election is filed. Hours cannot be freely mixed between properties.']].map(([ic,t,d])=>`<div style="display:flex;gap:12px;padding:12px 0;border-bottom:.5px solid #F0FDFA;align-items:flex-start;"><span style="font-size:18px;flex-shrink:0;">${ic}</span><div><div style="font-size:13px;font-weight:700;color:#0D1F3C;margin-bottom:3px;">${t}</div><div style="font-size:12px;color:#64748B;line-height:1.6;">${d}</div></div></div>`).join('')}
</div>`;
}

// ── RENDER ──
function renderView(){
  if(chartInst){chartInst.destroy();chartInst=null;}
  renderNav();updateSB();
  const el=document.getElementById('content');
  if(view==='dashboard') el.innerHTML=vDashboard();
  else if(view==='log') el.innerHTML=vLog();
  else if(view==='properties') el.innerHTML=vProps();
  else if(view==='mp') el.innerHTML=vMP();
  else if(view==='reports') el.innerHTML=vReports();
  else if(view==='ltr') el.innerHTML=vLTR();
  else if(view==='str') el.innerHTML=vSTR();
  else if(view==='settings') el.innerHTML=vSettings();
  else { view='dashboard'; el.innerHTML=vDashboard(); }

  // Restart timer display tick if timer is running and we're on the log page
  if(view==='log'&&timerStart){
    clearInterval(timerTick);
    timerTick=setInterval(()=>{
      const el=document.getElementById('timer-display');
      if(!el||!timerStart)return;
      const tot=Math.floor((Date.now()-timerStart)/1000);
      const h=Math.floor(tot/3600),m=Math.floor((tot%3600)/60),sc=tot%60;
      el.textContent=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    },1000);
  }
  if(view==='dashboard'){
    const cv=document.getElementById('mc');
    if(cv){
      const ye=state.entries.filter(e=>e.date&&e.date.startsWith(String(activeYear)));
      if(_chartTab==='monthly'){
        const monthly=Array.from({length:12},()=>({r:0,s:0}));
        ye.forEach(e=>{const m=new Date(e.date+'T12:00:00').getMonth();if(e.trackType==='STR')monthly[m].s+=e.hours||0;else monthly[m].r+=e.hours||0;});
        chartInst=new Chart(cv,{type:'bar',data:{labels:MONTHS,datasets:[
          {label:'REPS',data:monthly.map(m=>Math.round(m.r*10)/10),backgroundColor:'#14B8A6',borderRadius:3,barPercentage:.6},
          {label:'STR',data:monthly.map(m=>Math.round(m.s*10)/10),backgroundColor:'#38BDF8',borderRadius:3,barPercentage:.6}
        ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${c.parsed.y}h`}}},scales:{x:{grid:{display:false},ticks:{font:{size:11},color:'#64748B'},border:{display:false}},y:{grid:{color:'#F0FDFA'},ticks:{font:{size:11},color:'#64748B'},border:{display:false},beginAtZero:true}}}});
      } else {
        // By property view — horizontal bar per property
        const props=state.properties.length>0?state.properties:[{id:null,name:'General RE',type:'REPS'}];
        const propHrs=props.map(p=>({
          name:p.name.length>18?p.name.slice(0,18)+'…':p.name,
          reps:ye.filter(e=>e.propertyId===p.id&&e.trackType!=='STR'&&!e.isSpouse).reduce((a,e)=>a+(e.hours||0),0),
          str:ye.filter(e=>e.propertyId===p.id&&e.trackType==='STR'&&!e.isSpouse).reduce((a,e)=>a+(e.hours||0),0)
        }));
        // Also include general (no property)
        const genReps=ye.filter(e=>(!e.propertyId||e.propertyId==='')&&e.trackType!=='STR'&&!e.isSpouse).reduce((a,e)=>a+(e.hours||0),0);
        if(genReps>0&&state.properties.length>0)propHrs.push({name:'General RE',reps:genReps,str:0});
        chartInst=new Chart(cv,{type:'bar',data:{labels:propHrs.map(p=>p.name),datasets:[
          {label:'REPS',data:propHrs.map(p=>Math.round(p.reps*10)/10),backgroundColor:'#14B8A6',borderRadius:3,barPercentage:.6},
          {label:'STR',data:propHrs.map(p=>Math.round(p.str*10)/10),backgroundColor:'#38BDF8',borderRadius:3,barPercentage:.6}
        ]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${c.parsed.x}h`}}},scales:{x:{grid:{color:'#F0FDFA'},ticks:{font:{size:11},color:'#64748B'},border:{display:false},beginAtZero:true},y:{grid:{display:false},ticks:{font:{size:11},color:'#64748B'},border:{display:false}}}}});
      }
    }
  }
}

// ── REMY AI ASSISTANT ──
const REMY_EDGE_URL='https://ehuttijifubonhhgnvzx.supabase.co/functions/v1/remy-chat';

function toggleRemy(){
  remyOpen=!remyOpen;
  const panel=document.getElementById('remy-panel');
  const backdrop=document.getElementById('remy-backdrop');
  const btn=document.getElementById('remy-btn');
  if(!panel||!backdrop)return;
  if(remyOpen){
    panel.style.display='flex';
    backdrop.style.display='block';
    if(btn)btn.style.opacity='.7';
    // Load saved messages (filter out any malformed entries from prior versions)
    try{const saved=localStorage.getItem(REMY_SK);if(saved){const parsed=JSON.parse(saved);if(Array.isArray(parsed))remyMessages=parsed.filter(m=>m&&typeof m==='object'&&m.role&&m.content!=null&&m.content!=='');}}catch(e){}
    renderRemyMessages();
    // Greeting if no messages yet
    if(remyMessages.length===0){
      const ctx=buildRemyCtx();
      const rh=Math.round(ctx.rh||0);
      const greeting=ctx.ok
        ?`Hi! I'm Remy 👋 You've qualified for REPS this year with ${rh} hrs. What would you like to dig into?`
        :`Hi! I'm Remy 👋 You have ${rh} hrs logged — ${Math.max(0,Math.ceil(750-rh+0.01))} more needed to exceed the 750-hr test. How can I help?`;
      addRemyMessage('assistant',greeting);
    }
    setTimeout(()=>document.getElementById('remy-input')?.focus(),50);
  } else {
    panel.style.display='none';
    backdrop.style.display='none';
    if(btn)btn.style.opacity='1';
  }
}

function buildRemyCtx(){
  const r=calcREPS();
  const ye=yearEntries();
  return{
    year:activeYear,
    rh:r.rh,pct:r.pct,m750:r.m750,m50:r.m50,incomplete50:r.incomplete50,ok:r.ok,
    nonREPSHours:state.settings.nonREPSHours||0,
    groupingElection:!!state.settings.groupingElection,
    includeSTRinREPS:state.settings.includeSTRinREPS===true,
    spouseEnabled:!!state.settings.spouseEnabled,
    spouseName:state.settings.spouseName||'',
    properties:state.properties.map(p=>{
      const ph_=pH(p.id);
      return{
        name:p.name,type:p.type,
        avgRentalDays:p.avgRentalDays||null,
        otherHours:p.otherHours||0,
        otherHoursCompensated:!!p.otherHoursCompensated,
        ownerHrs:ph_.owner,
        mpMet:mpT(p.id).some(t=>t.met),
      };
    }),
    entryCount:ye.length,
    repsCount:ye.filter(e=>e.trackType==='REPS'&&!e.isSpouse).length,
    strCount:ye.filter(e=>e.trackType==='STR'&&!e.isSpouse).length,
  };
}

function addRemyMessage(role,content){
  remyMessages.push({role,content});
  try{localStorage.setItem(REMY_SK,JSON.stringify(remyMessages.slice(-40)));}catch(e){}
  renderRemyMessages();
}

function renderRemyMessages(){
  const el=document.getElementById('remy-messages');
  if(!el)return;
  el.innerHTML=remyMessages.map(m=>{
    const isUser=m.role==='user';
    // AUDIT FIX: defend against legacy/corrupt messages with no content field
    const content=m.content==null?'':String(m.content);
    return`<div style="display:flex;justify-content:${isUser?'flex-end':'flex-start'};gap:8px;align-items:flex-end;">
      ${!isUser?`<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#14B8A6,#38BDF8);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;" aria-hidden="true">✨</div>`:''}
      <div style="max-width:78%;padding:10px 13px;border-radius:${isUser?'14px 14px 4px 14px':'14px 14px 14px 4px'};background:${isUser?'linear-gradient(135deg,#0D1F3C,#1a3a5c)':'#fff'};color:${isUser?'#fff':'#0D1F3C'};font-size:13px;line-height:1.6;box-shadow:0 1px 3px rgba(0,0,0,.08);white-space:pre-wrap;word-break:break-word;">${esc(content)}</div>
    </div>`;
  }).join('');
  // Typing indicator
  if(remyLoading){
    el.innerHTML+=`<div style="display:flex;justify-content:flex-start;gap:8px;align-items:flex-end;">
      <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#14B8A6,#38BDF8);display:flex;align-items:center;justify-content:center;font-size:13px;" aria-hidden="true">✨</div>
      <div style="padding:12px 16px;border-radius:14px 14px 14px 4px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="width:7px;height:7px;border-radius:50%;background:#14B8A6;animation:remyDot 1.2s ease-in-out infinite;"></span>
          <span style="width:7px;height:7px;border-radius:50%;background:#14B8A6;animation:remyDot 1.2s ease-in-out .2s infinite;"></span>
          <span style="width:7px;height:7px;border-radius:50%;background:#14B8A6;animation:remyDot 1.2s ease-in-out .4s infinite;"></span>
        </div>
      </div>
    </div>`;
  }
  el.scrollTop=el.scrollHeight;
}

async function remySend(){
  const input=document.getElementById('remy-input');
  const text=(input?.value||'').trim();
  if(!text||remyLoading)return;
  input.value='';
  addRemyMessage('user',text);
  remyLoading=true;
  renderRemyMessages();
  const sendBtn=document.getElementById('remy-send');
  if(sendBtn){sendBtn.disabled=true;sendBtn.style.opacity='.5';}
  try{
    const sess=_sb?await _sb.auth.getSession():null;
    const token=sess?.data?.session?.access_token||SUPABASE_ANON_KEY;
    const res=await fetch(REMY_EDGE_URL,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${token}`,
      },
      body:JSON.stringify({
        messages:remyMessages.slice(-20).map(m=>({role:m.role,content:m.content})),
        ctx:buildRemyCtx(),
      }),
    });
    const data=await res.json();
    if(data.error)throw new Error(data.error);
    addRemyMessage('assistant',data.reply);
  }catch(err){
    addRemyMessage('assistant',`Sorry, I ran into an error: ${err.message}. Please try again in a moment.`);
  }finally{
    remyLoading=false;
    if(sendBtn){sendBtn.disabled=false;sendBtn.style.opacity='1';}
    renderRemyMessages();
  }
}

function clearRemyHistory(){
  remyMessages=[];
  try{localStorage.removeItem(REMY_SK);}catch(e){}
  renderRemyMessages();
}

// ── EXCEL EXPORT ──
async function exportXLSX(){
  const _done=toast('Preparing Excel file…','info',{duration:0});
  try{
  // Load SheetJS if not already present
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const sc=document.createElement('script');
      sc.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      sc.onload=res;sc.onerror=()=>rej(new Error('Could not load Excel library — check your connection'));
      document.head.appendChild(sc);
    });
  }
  // Load JSZip (used to bundle evidence files into the download so links never expire).
  // If it fails to load we fall back to a plain .xlsx export below — export never breaks.
  if(!window.JSZip){
    try{
      await new Promise((res,rej)=>{
        const sc=document.createElement('script');
        sc.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        sc.onload=res;sc.onerror=()=>rej(new Error('jszip load failed'));
        document.head.appendChild(sc);
      });
    }catch(e){ console.warn('[exportXLSX] JSZip unavailable — exporting plain .xlsx',e); }
  }

  const r=calcREPS();
  const ye=yearEntries();
  const sps=state.properties.filter(p=>p.type==='STR');
  const repsEntries=[...ye].filter(e=>e.trackType!=='STR'||state.settings.includeSTRinREPS===true).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const strEntries=[...ye].filter(e=>e.trackType==='STR').sort((a,b)=>new Date(b.date)-new Date(a.date));
  const allEntries=[...ye].sort((a,b)=>new Date(b.date)-new Date(a.date));

  // Pass 8 (private-storage): pre-resolve a time-limited SIGNED url for each attachment so the
  // exported workbook keeps working after the Evidence bucket is made private. Falls back to any
  // legacy public url. Signed links expire (7 days here) — for a fresh link, open from the app.
  const _attUrlMap=new Map();
  if(_sb){
    const _atts=allEntries.flatMap(e=>(e.attachments||[])).filter(a=>a&&a.path);
    await Promise.all(_atts.map(async a=>{
      if(!_attUrlMap.has(a.path)){
        try{const{data}=await _sb.storage.from('Evidence').createSignedUrl(a.path,604800);if(data&&data.signedUrl)_attUrlMap.set(a.path,data.signedUrl);}catch(e){}
      }
    }));
  }

  function propName(e){return state.properties.find(p=>p.id===e.propertyId)?.name||'General RE';}
  function fmtDecHrs(h){return Math.round(h*100)/100;}
  function fmtHMLabel(h){const a=Math.floor(h),b=Math.round((h-a)*60);return b===0?`${a}h`:`${a}h ${b}m`;}
  // ── Evidence helper: returns {name, url, bundlePath} for an entry ──
  // bundlePath is the file's location INSIDE the exported zip (evidence/<property>/<date>_<file>),
  // so the workbook can link to the bundled copy that never expires.
  const _safeSeg=s=>String(s||'').replace(/[^a-zA-Z0-9._ -]/g,'_').replace(/\s+/g,' ').trim().slice(0,60)||'_';
  const _bundleSeen={};
  function getAttachments(e){
    const prop=_safeSeg(propName(e));
    return(e.attachments||[])
      .map(a=>{
        const url=(a.path&&_attUrlMap.get(a.path))||a.url||a.publicUrl||a.href||'';
        let bundlePath='';
        if(a.path||url){
          let fn=_safeSeg((e.date?e.date+'_':'')+(a.name||'evidence'));
          let rel='evidence/'+prop+'/'+fn;
          // de-dupe identical relative paths (same file name attached twice, etc.)
          if(_bundleSeen[rel]!=null){_bundleSeen[rel]++;const dot=fn.lastIndexOf('.');fn=dot>0?fn.slice(0,dot)+'_'+_bundleSeen[rel]+fn.slice(dot):fn+'_'+_bundleSeen[rel];rel='evidence/'+prop+'/'+fn;}
          else{_bundleSeen[rel]=0;}
          bundlePath=rel;
        }
        return{name:a.name||'Evidence',url,path:a.path||'',bundlePath};
      })
      .filter(a=>a.url||a.path);
  }
  // Collects {bundlePath, url, path} for every attachment we reference, so we can fetch + zip them.
  const _bundleList=[];

  const wb=XLSX.utils.book_new();

  // ─── Sheet 1: Summary ───
  const repsRows=[
    ['REPSRECORD — IRS AUDIT DOCUMENTATION','','',''],
    [`Tax Year: ${activeYear}`,'','',''],
    ['Generated: '+new Date().toLocaleDateString(),'','',''],
    ['','','',''],
    ['REPS QUALIFICATION SUMMARY — IRC §469(c)(7)','','',''],
    ['Test','Result','Your Value','Required'],
    ['750-Hour Test', r.m750?'✓ MET':'✗ NOT MET', Math.round(r.rh)+' hrs','> 750 hrs'],
    ['50% Services Test', r.m50?'✓ MET':'✗ NOT MET', Math.round(r.pct)+'%','> 50%'],
    ['Overall REPS Status', r.ok?'✓ QUALIFIED':(r.incomplete50?'PENDING — verify non-RE hours':'✗ NOT QUALIFIED'),'','Both tests required'],
    ['Non-RE Hours Entered',(state.settings.nonREPSHours||0)>0?'Yes — '+state.settings.nonREPSHours+' hrs':'⚠ Not entered — 50% test unverified','',''],
    ['Grouping Election',state.settings.groupingElection?'Filed — §469(c)(7)(A)':'Not filed','',''],
    ['','','',''],
  ];

  if(sps.length){
    repsRows.push(['STR MATERIAL PARTICIPATION — TEMP. REG. §1.469-5T','','','']);
    repsRows.push(['Property','Avg Rental Days','Your Hours','MP Status']);
    sps.forEach(p=>{
      const ph=pH(p.id);
      const ts=mpT(p.id);
      const any=ts.some(t=>t.met);
      const best=ts.find(t=>t.met);
      repsRows.push([p.name, p.avgRentalDays||'Not set', Math.round(ph.owner), any?('✓ '+best.label):'✗ Does Not Qualify']);
      // Show which tests passed/failed
      ts.forEach(t=>{
        repsRows.push(['  '+t.name+' — '+t.label,'','',t.met?'✓ Met':'—']);
      });
      repsRows.push(['','','','']);
    });
  }

  const wsSummary=XLSX.utils.aoa_to_sheet(repsRows);
  wsSummary['!cols']=[{wch:40},{wch:28},{wch:16},{wch:22}];
  XLSX.utils.book_append_sheet(wb,wsSummary,'Summary');

  // ─── Sheet builder helper ───
  // Columns: ... | Evidence File (H) | Bundled File Path (I) | Online Link (J)
  //   • Col H: filename, linked to the file bundled INSIDE the zip — never expires.
  //   • Col I: the relative path of that bundled file (plain text, for reference).
  //   • Col J: the signed online link (expires; convenience only).
  function buildActivitySheet(entries){
    const headers=['Date','Property','Type','Category','Hours (decimal)','Hours (formatted)','Notes','Evidence File (bundled — never expires)','Bundled File Path','Online Link (expires)'];
    const rows=[];
    const linkMeta=[];// {rowIdx, bundlePath, url, name}

    entries.forEach(e=>{
      const atts=getAttachments(e);
      if(atts.length===0){
        rows.push([e.date,propName(e),e.trackType+(e.isSpouse?' (Spouse)':''),e.category,fmtDecHrs(e.hours),fmtHMLabel(e.hours),e.notes||'','','','']);
        linkMeta.push(null);
      } else {
        atts.forEach((att,ai)=>{
          // Record the file for zipping (only once per unique bundlePath)
          if(att.bundlePath){_bundleList.push({bundlePath:att.bundlePath,url:att.url,path:att.path});}
          rows.push([
            ai===0?e.date:'',
            ai===0?propName(e):'',
            ai===0?e.trackType+(e.isSpouse?' (Spouse)':''):'',
            ai===0?e.category:'',
            ai===0?fmtDecHrs(e.hours):'',
            ai===0?fmtHMLabel(e.hours):'',
            ai===0?e.notes||'':'',
            att.name,            // col H — filename (will be linked to bundled file)
            att.bundlePath||'',  // col I — relative path inside the zip
            att.url||'',         // col J — signed online link (expires)
          ]);
          linkMeta.push({bundlePath:att.bundlePath,url:att.url,name:att.name});
        });
      }
    });

    const ws=XLSX.utils.aoa_to_sheet([headers,...rows]);
    ws['!cols']=[{wch:13},{wch:22},{wch:10},{wch:36},{wch:14},{wch:12},{wch:44},{wch:40},{wch:46},{wch:50}];

    // Link col H (index 7) to the BUNDLED file via a relative path — opens the copy
    // packaged in the zip, so it never expires. Relative targets keep working as long
    // as the .xlsx stays next to the evidence/ folder (i.e. the zip is kept together).
    // Col J (index 9) keeps the signed online link as a clickable convenience.
    linkMeta.forEach((m,i)=>{
      if(!m)return;
      if(m.bundlePath){
        const refH=XLSX.utils.encode_cell({r:i+1,c:7});
        if(ws[refH]){const _encTarget=m.bundlePath.split('/').map(function(seg){return encodeURIComponent(seg);}).join('/');ws[refH]={t:'s',v:m.name||'Evidence',l:{Target:_encTarget,Tooltip:'Opens the bundled evidence file (kept inside this package — never expires)'}};}
      }
      if(m.url){
        const refJ=XLSX.utils.encode_cell({r:i+1,c:9});
        if(ws[refJ]){ws[refJ]={t:'s',v:m.url,l:{Target:m.url,Tooltip:'Online link — expires; re-export for a fresh one'}};}
      }
    });

    return ws;
  }

  // ─── Sheet 2: REPS Activity Log ───
  const repsActivity=allEntries.filter(e=>e.trackType!=='STR');
  if(repsActivity.length){
    const ws=buildActivitySheet(repsActivity,'REPS Activity Log');
    XLSX.utils.book_append_sheet(wb,ws,'REPS Activity Log');
  }

  // ─── Sheet 3: STR Activity Log ───
  if(strEntries.length){
    const ws=buildActivitySheet(strEntries,'STR Activity Log');
    XLSX.utils.book_append_sheet(wb,ws,'STR Activity Log');
  }

  // ─── Sheet 4: All Entries (combined) ───
  if(allEntries.length){
    const ws=buildActivitySheet(allEntries,'All Entries');
    XLSX.utils.book_append_sheet(wb,ws,'All Entries');
  }

  // ─── Download ───
  const stamp=new Date().toISOString().slice(0,10);
  const xlsxName=`RepsRecord_${activeYear}_AuditLog_${stamp}.xlsx`;

  // De-dupe the bundle list by path (same file can appear across multiple sheets/rows).
  const _seenPaths={};
  const bundleFiles=_bundleList.filter(b=>b&&b.bundlePath&&!_seenPaths[b.bundlePath]&&(_seenPaths[b.bundlePath]=1));

  // If JSZip loaded AND there are evidence files, bundle everything into one .zip so the
  // in-sheet links to evidence/... never expire. Otherwise fall back to a plain .xlsx.
  if(window.JSZip && bundleFiles.length){
    _done();
    const _zdone=toast(`Bundling ${bundleFiles.length} evidence file${bundleFiles.length===1?'':'s'}…`,'info',{duration:0});
    try{
      const zip=new JSZip();
      // Workbook as binary, written into the zip root.
      const wbOut=XLSX.write(wb,{type:'array',bookType:'xlsx'});
      zip.file(xlsxName,wbOut);

      // Fetch each evidence file (signed url first, fall back to a fresh signed url from path).
      let fetched=0, failedFiles=[];
      await Promise.all(bundleFiles.map(async b=>{
        try{
          let u=b.url;
          if(!u && b.path && _sb){const{data}=await _sb.storage.from('Evidence').createSignedUrl(b.path,3600);u=data&&data.signedUrl;}
          if(!u) throw new Error('no url');
          const resp=await fetch(u);
          if(!resp.ok) throw new Error('http '+resp.status);
          const buf=await resp.arrayBuffer();
          zip.file(b.bundlePath,buf);
          fetched++;
        }catch(e){failedFiles.push(b.bundlePath);console.warn('[exportXLSX] evidence fetch failed',b.bundlePath,e);}
      }));

      // A short README so an auditor knows how to use the package.
      zip.file('README.txt',
        'RepsRecord — IRS Audit Documentation Package\n'+
        'Tax Year: '+activeYear+'\n'+
        'Generated: '+new Date().toLocaleString()+'\n\n'+
        'Contents:\n'+
        '  • '+xlsxName+' — the audit log / activity report.\n'+
        '  • evidence/ — the supporting files referenced in the report.\n\n'+
        'In the spreadsheet, the "Evidence File" column links to the bundled copy in the\n'+
        'evidence/ folder. Keep this package together (unzip it as a whole) so those links\n'+
        'continue to work — they do not expire. The "Online Link" column is a convenience\n'+
        'link that DOES expire; re-export from the app for a fresh one.\n'+
        (failedFiles.length?('\nNOTE: '+failedFiles.length+' file(s) could not be retrieved at export time:\n  '+failedFiles.join('\n  ')+'\n'):'')
      );

      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
      const zipName=`RepsRecord_${activeYear}_AuditPackage_${stamp}.zip`;
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=zipName;
      document.body.appendChild(a);a.click();
      setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},2000);
      _zdone();
      if(failedFiles.length){toast(`Audit package downloaded. ${fetched} file(s) bundled; ${failedFiles.length} couldn’t be retrieved (listed in README).`,'warn',{duration:8000});}
      else{toast(`Audit package downloaded — report + ${fetched} evidence file(s), links never expire.`,'success');}
    }catch(err){
      _zdone();
      console.error('[exportXLSX] zip failed, falling back to .xlsx',err);
      XLSX.writeFile(wb,xlsxName);
      toast('Evidence couldn’t be bundled; downloaded the Excel report on its own.','warn');
    }
  } else {
    // No evidence files (or JSZip unavailable) — plain Excel download as before.
    XLSX.writeFile(wb,xlsxName);
    _done();
    toast(window.JSZip?'Excel file downloaded.':'Excel file downloaded (evidence bundling unavailable).','success');
  }
  }catch(err){
    _done();
    console.error('[exportXLSX]',err);
    toast(err.message||'Could not export Excel file.','error');
  }
}

// ── App init — async to support cloud-first data load ──
async function appInit(){
  // Initialize Supabase client and get session
  if(window.supabase){
    try{
      _sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
      const{data:{session}}=await _sb.auth.getSession();
      if(session){_sbUser=session.user;}
    }catch(e){_sb=null;}
  }
  // Paywall gate: require an active trial/subscription before the app loads.
  const _gate=await enforceSubscription();
  if(_gate==='blocked'||_gate==='redirect') return;
  // Load data: cloud first, localStorage fallback
  try{
    await load();
    // Populate year dropdown
    const yrSel=document.getElementById('year-sel');
    if(yrSel){
      YEARS.forEach(y=>{
        const o=document.createElement('option');
        o.value=y;o.textContent=y+' Tax Year';
        o.style.background='#0D1F3C';
        if(y===activeYear)o.selected=true;
        yrSel.appendChild(o);
      });
    }
    renderView();
    setTimeout(showWalkthrough,800);
  }catch(e){
    // Never strand the user on the loading spinner — surface the failure and render what we can.
    console.error('[appInit]',e);
    try{ renderView(); }catch(_){}
    toast('Something went wrong while starting up. Your data is safe on this device — try reloading the page.','error',{duration:0});
  }
}
initDelegation();
appInit();

// ── FIRST-TIME WALKTHROUGH ──
const WALK_KEY='repsrecord_walked_v1';
const steps=[
  {
    icon:'👋',
    title:'Welcome to RepsRecord!',
    body:`<p>RepsRecord helps you track your real estate hours so you can <strong>qualify for REPS status</strong> and the <strong>STR material participation exception</strong> — and survive an IRS audit if it ever comes.</p>
    <p style="margin-top:12px;">This quick 5-step walkthrough will show you exactly how to use it. Takes about 2 minutes.</p>`,
    tip:null
  },
  {
    icon:'🏡',
    title:'REPS or STR — which do I pick?',
    body:`<p><strong style="color:#14B8A6;">REPS (Real Estate Professional Status)</strong> — Log hours here for long-term rentals and other qualifying real estate activities. These count toward your 750-hour REPS qualification.</p>
    <p style="margin-top:10px;"><strong style="color:#38BDF8;">STR (Short-Term Rental)</strong> — Log hours here for Airbnb, VRBO, or any property where guests typically stay 7 days or less. Tracked separately for the material participation tests.</p>
    <p style="margin-top:10px;padding:10px 12px;background:#F0FDFA;border-radius:8px;font-size:13px;color:#0E7490;">Have <strong>both LTR and STR properties?</strong> You\'ll use both tabs — REPS for your long-term rentals, STR for your short-term rentals.</p>`,
    tip:'💡 Monthly lease tenant = log as REPS. Vacation/Airbnb rental = log as STR.'
  },
  {
    icon:'📋',
    title:'What counts as a qualifying activity?',
    body:`<p>When you log an entry, you pick an <strong>Activity Category</strong>. Here are examples of what counts:</p>
    <ul style="margin-top:10px;list-style:none;display:flex;flex-direction:column;gap:7px;">
      <li>✅ <strong>Property Management</strong> — managing tenants, handling issues, inspections</li>
      <li>✅ <strong>Maintenance &amp; Repairs</strong> — fixing things yourself or coordinating repairs</li>
      <li>✅ <strong>Guest Communication</strong> — messaging guests, answering questions (STR)</li>
      <li>✅ <strong>Financial &amp; Accounting</strong> — reviewing income, expenses, bookkeeping</li>
      <li>✅ <strong>Travel</strong> — driving to and from your property for a qualifying purpose</li>
      <li>❌ <strong>Personal use</strong> of the property does NOT count</li>
    </ul>`,
    tip:'💡 When in doubt, log it and add a good description. Your tax professional can review.'
  },
  {
    icon:'⏱',
    title:'How to log an entry',
    body:`<p>Logging an entry takes about <strong>60 seconds</strong>. Here's all you do:</p>
    <ol style="margin-top:10px;list-style:none;display:flex;flex-direction:column;gap:8px;">
      <li><strong>1.</strong> Go to <strong>Log Time</strong> in the left menu</li>
      <li><strong>2.</strong> Toggle REPS or STR at the top</li>
      <li><strong>3.</strong> Pick the date and your property</li>
      <li><strong>4.</strong> Select the activity category</li>
      <li><strong>5.</strong> Enter hours and minutes</li>
      <li><strong>6.</strong> Add a description (very important!)</li>
      <li><strong>7.</strong> Optionally attach a receipt or photo</li>
      <li><strong>8.</strong> Hit <strong>Log Entry</strong> ✓</li>
    </ol>`,
    tip:'💡 Before logging, make sure your properties are added in the Properties page — you\'ll need them in the dropdown. Log hours the same day you do the work for the strongest IRS records.'
  },
  {
    icon:'✍️',
    title:'What to write in the description',
    body:`<p>The description is your most important field. The IRS wants to see <strong>specific details</strong> — not vague labels.</p>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <div style="background:#FEF2F2;border-radius:8px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:#991B1B;margin-bottom:4px;">❌ TOO VAGUE</div>
        <div style="font-size:13px;color:#7F1D1D;">"Property management"</div>
      </div>
      <div style="background:#ECFDF5;border-radius:8px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:#065F46;margin-bottom:4px;">✅ MUCH BETTER</div>
        <div style="font-size:13px;color:#064E3B;">"Called plumber re: unit 3 leak. Scheduled repair for Friday. Contacted tenant to arrange access."</div>
      </div>
    </div>
    <p style="margin-top:12px;font-size:13px;color:#64748B;">Who you talked to, what property, what decision was made, what was the outcome.</p>`,
    tip:'💡 Think of it like a work journal. If an IRS agent read it 3 years from now, would they understand exactly what you did?'
  },
  {
    icon:'🎉',
    title:'You\'re ready to go!',
    body:`<p>That's it! Here's a quick summary:</p>
    <ul style="margin-top:10px;list-style:none;display:flex;flex-direction:column;gap:8px;">
      <li>📊 <strong>Dashboard</strong> — tracks your progress toward 750 hrs and MP tests</li>
      <li>⏱ <strong>Log Time</strong> — add entries as you do the work</li>
      <li>🏠 <strong>Properties</strong> — add your rental properties here first</li>
      <li>✅ <strong>MP Tests</strong> — see if each STR property qualifies</li>
      <li>📋 <strong>Audit Report</strong> — one click to generate your IRS-ready report</li>
      <li>🏡 <strong>REPS Rules</strong> — IRC §469(c)(7) qualification guide</li>
      <li>🏖 <strong>STR Rules</strong> — short-term rental material participation guide</li>
    </ul>
    <p style="margin-top:12px;color:#14B8A6;font-weight:700;">Start by adding your properties, then log your first entry today!</p>`,
    tip:null
  }
];

let walkStep=0;

function showWalkthrough(){
  if(localStorage.getItem(WALK_KEY))return;
  const el=document.getElementById('walk-overlay');
  if(el){el.style.display='flex';renderWalkStep();}
}

function renderWalkStep(){
  const s=steps[walkStep];
  const total=steps.length;
  document.getElementById('walk-icon').textContent=s.icon;
  document.getElementById('walk-title').textContent=s.title;
  document.getElementById('walk-body').innerHTML=s.body;
  const tipEl=document.getElementById('walk-tip');
  if(s.tip){tipEl.style.display='block';tipEl.textContent=s.tip;}
  else{tipEl.style.display='none';}
  document.getElementById('walk-back').style.display=walkStep===0?'none':'inline-flex';
  const nextBtn=document.getElementById('walk-next');
  nextBtn.textContent=walkStep===total-1?'Start tracking →':'Next →';
  // dots
  const dots=document.getElementById('walk-dots');
  dots.innerHTML=steps.map((_,i)=>`<div style="width:8px;height:8px;border-radius:50%;background:${i===walkStep?'#14B8A6':'#1E4A6E'};transition:background .2s;"></div>`).join('');
}

function walkNext(){
  if(walkStep<steps.length-1){walkStep++;renderWalkStep();}
  else{closeWalkthrough();go('properties');}
}
function walkBack(){if(walkStep>0){walkStep--;renderWalkStep();}}
function closeWalkthrough(){
  localStorage.setItem(WALK_KEY,'1');
  const el=document.getElementById('walk-overlay');
  if(el)el.style.display='none';
}

// Show after a short delay so the app loads first
setTimeout(showWalkthrough,800);
