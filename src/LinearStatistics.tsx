import { releaseStamp, type BuildMetadata, type ReleaseMetadata } from './releaseMetadata';
import { useT } from './Preferences';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePreferences, QuestionText } from './Preferences';

type Event = { id: string; topic: string; answered_at: string; correct: boolean; mode: string; question: string; translations?: Record<string,string>; image_url: string; help: Record<string,string>; answers: {letter:string;text:string;translations?:Record<string,string>;correct:boolean;selected:boolean}[] };
type TopicRow = { topic: string; correct: number; wrong: number; topic_id?:string };
type TimelinePage = { events: Event[]; total: number; correct: number; has_more: boolean };
type TopicsPage = { rows: TopicRow[]; total: number; has_more: boolean; days: string[] };
const ratio = (n:number,total:number) => total ? `${(100*n/total).toLocaleString('en-GB',{maximumFractionDigits:1})}%` : '0%';

// Each panel requests its own pages; totals always cover the complete query.
function usePages<T extends {total:number;has_more:boolean},R>(query:string,items:(page:T)=>R[]) {
 const [state,setState]=useState<{key:string;page:T|null;rows:R[];loading:boolean;error:string}>({key:'',page:null,rows:[],loading:false,error:''});
 const [retry,setRetry]=useState(0);
 const pending=useRef(false);
 const generation=useRef(query);
 useEffect(()=>{
  const controller=new AbortController();generation.current=query;pending.current=true;
  fetch(`${query}&offset=0`,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return await r.json() as T;}).then(page=>{
   setState({key:query,page,rows:items(page),loading:false,error:''});
  }).catch(()=>{if(!controller.signal.aborted)setState({key:query,page:null,rows:[],loading:false,error:'Could not load statistics.'});}).finally(()=>{if(generation.current===query)pending.current=false;});
  return()=>controller.abort();
 },[query,items,retry]);
 async function more(){
  if(pending.current||state.key!==query)return;
  if(!state.page){setRetry(n=>n+1);return;}
  if(!state.page.has_more)return;
  pending.current=true;setState(s=>({...s,loading:true,error:''}));
  try {
   const response=await fetch(`${query}&offset=${state.rows.length}`,{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw Error();const page=await response.json() as T;
   if(generation.current===query)setState(s=>({...s,page,rows:[...s.rows,...items(page)],loading:false,error:''}));
  }catch{if(generation.current===query)setState(s=>({...s,loading:false,error:'Could not load the next page.'}));}
  finally{if(generation.current===query)pending.current=false;}
 }
 return {page:state.key===query?state.page:null,rows:state.key===query?state.rows:[],loading:state.key!==query||state.loading,error:state.key===query?state.error:'',more};
}
const timelineItems=(page:TimelinePage)=>page.events;
const topicItems=(page:TopicsPage)=>page.rows;
function Loading(){
  const t = useT();return <div className="statistics-loading" role="status"><span className="page-spinner"/><span className="sr-only">{t("Loading statistics")}</span></div>;}

const dayKey=(date:Date)=>date.toISOString().slice(0,10);
function MonthCalendar({days,range,onChange,arbitrary=true}:{days:string[];range:{from:string;to:string}|null;onChange:(range:{from:string;to:string}|null)=>void;arbitrary?:boolean}) {
  const t = useT();
  const { preferences } = usePreferences();
  const locale = preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB';
 const [open,setOpen]=useState(false);
 const [draft,setDraft]=useState({from:'',to:''});
 const [month,setMonth]=useState(()=>new Date().toISOString().slice(0,7));
 const [position,setPosition]=useState({left:12,top:12});
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[open]);
 const first=new Date(`${month}-01T00:00:00Z`);
 const end=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));
 const start=new Date(first);start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
 const weeks=Array.from({length:Math.ceil((((first.getUTCDay()+6)%7)+end.getUTCDate())/7)},(_,week)=>Array.from({length:7},(_,day)=>new Date(start.getTime()+(week*7+day)*86400000)));
 const available=new Set(days);
 function move(delta:number){setMonth(dayKey(new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+delta,1))).slice(0,7));}
 function select(from:string,to:string){onChange({from,to});setOpen(false);}
 const label=range?range.from.slice(0,7)===range.to.slice(0,7)&&range.from.endsWith('-01')&&range.to===dayKey(new Date(Date.UTC(Number(range.from.slice(0,4)),Number(range.from.slice(5,7)),0)))?new Date(`${range.from}T00:00:00Z`).toLocaleDateString(locale,{month:'long',year:'numeric',timeZone:'UTC'}):`${range.from.split('-').reverse().join('.')} — ${range.to.split('-').reverse().join('.')}`:t('All time');
 return <div className="statistics-calendar" ref={root}><button className="calendar-trigger" aria-expanded={open} onClick={()=>{if(!open){setDraft(range??{from:'',to:''});setMonth(range?.from.slice(0,7)||days[0]?.slice(0,7)||month);const rect=root.current!.getBoundingClientRect();setPosition({left:Math.max(12,Math.min(rect.right-280,window.innerWidth-292)),top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-(arbitrary?440:310)))});}setOpen(!open);}}>▦ {label}</button>{open&&<div className="calendar-popover" style={position}><header><button aria-label={t("Previous month")} onClick={()=>move(-1)}>‹</button><button className="calendar-month" title={t("Select entire month")} onClick={()=>select(dayKey(first),dayKey(end))}>{first.toLocaleDateString(locale,{month:'long',year:'numeric',timeZone:'UTC'})}</button><button aria-label={t("Next month")} onClick={()=>move(1)}>›</button></header><div className="calendar-weekdays">{[t("Mon"),t("Tue"),t("Wed"),t("Thu"),t("Fri"),t("Sat"),t("Sun")].map(d=><span key={d}>{t(d)}</span>)}</div>{weeks.map(week=><div className="calendar-week" key={dayKey(week[0])}>{week.map(date=>{const key=dayKey(date);const selection=draft.from&&draft.to?draft:range;return <button key={key} type="button" aria-label={date.toLocaleDateString(locale,{dateStyle:'long',timeZone:'UTC'})} aria-pressed={Boolean(selection&&key>=selection.from&&key<=selection.to)} className={`${key.slice(0,7)!==month?'outside':''} ${available.has(key)?'has-answers':''} ${selection&&key>=selection.from&&key<=selection.to?'selected':''} ${draft.from===key&&!draft.to?'range-start':''}`} onClick={()=>setDraft(current=>current.from&&!current.to?{from:current.from<key?current.from:key,to:current.from<key?key:current.from}:{from:key,to:''})}>{date.getUTCDate()}</button>;})}</div>)}{arbitrary&&<div className="calendar-custom-range"><label>{t("From")}<input type="date" value={draft.from} max={draft.to||undefined} onChange={e=>setDraft(current=>({...current,from:e.target.value}))}/></label><label>{t("To")}<input type="date" value={draft.to} min={draft.from||undefined} onChange={e=>setDraft(current=>({...current,to:e.target.value}))}/></label><button disabled={!draft.from||!draft.to||draft.from>draft.to} onClick={()=>select(draft.from,draft.to)}>{t("Apply")}</button></div>}<footer><span>{t("Select the start and end dates")}</span><button onClick={()=>{onChange(null);setOpen(false);}}>{t("All time")}</button></footer></div>}</div>;
}

type ResultSort = {column:'correct'|'wrong';direction:'asc'|'desc'};
function ResultCells({row}:{row:TopicRow}) {
 return <><td className="statistics-total">{row.correct+row.wrong}</td><td className="linear-good-text">{ratio(row.correct,row.correct+row.wrong)} <small>({row.correct})</small></td><td className="linear-bad-text">{ratio(row.wrong,row.correct+row.wrong)} <small>({row.wrong})</small></td></>;
}
function SortColumns({sort,onSort}:{sort:ResultSort;onSort:(column:'correct'|'wrong')=>void}) {
  const t = useT();
 return <>{(['correct','wrong'] as const).map(column=><th scope="col" key={column} aria-sort={sort.column===column?sort.direction==='desc'?'descending':'ascending':'none'}><button onClick={()=>onSort(column)}>{column==='correct'?t("Correct"):t("Incorrect")} <span>{sort.column===column?sort.direction==='desc'?'↓':'↑':'↕'}</span></button></th>)}</>;
}
function periodQuery(range:{from:string;to:string}|null){return range?`&from=${encodeURIComponent(new Date(`${range.from}T00:00:00`).toISOString())}&to=${encodeURIComponent(nextDayStart(range.to).toISOString())}`:'';}
function nextDayStart(day:string){const date=new Date(`${day}T00:00:00`);date.setDate(date.getDate()+1);return date;}
function questionGroup(at:string,grouping:'none'|'months'|'weeks',locale:string) {
 const date=new Date(at);
 if(grouping==='months')return date.toLocaleDateString(locale,{month:'long',year:'numeric'});
 if(grouping==='none')return '';
 date.setHours(0,0,0,0);date.setDate(date.getDate()-((date.getDay()+6)%7));
 const end=new Date(date);end.setDate(end.getDate()+6);
 return `${date.toLocaleDateString(locale)} — ${end.toLocaleDateString(locale)}`;
}
function QuestionHistoryRow({event,index,onOpen}:{event:Event;index:number;onOpen:(event:Event,index:number,button:HTMLButtonElement)=>void}) {
  const t = useT();
  const { preferences } = usePreferences();
  const locale = preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB';

 return <div className={`linear-chip statistics-question-row ${event.correct?'passed':'failed'}`}><b>{index+1}</b><time dateTime={event.answered_at}>{new Date(event.answered_at).toLocaleString(locale,{dateStyle:'short',timeStyle:'short'})}</time><span>{event.topic}</span><button className="statistics-eye" aria-label={t('Open question {number}', {number:index+1})} aria-haspopup="dialog" onClick={e=>onOpen(event,index,e.currentTarget)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button><i aria-hidden="true">{event.correct?'✓':'×'}</i></div>;
}

export function LinearStatistics({onBack,onOpenTopic}:{onBack:()=>void;onOpenTopic:(id:string)=>void}) {
  const t = useT();
  const { preferences } = usePreferences();
  const locale = preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB';
 const [questionsOpen,setQuestionsOpen]=useState(true);
 const [topicsOpen,setTopicsOpen]=useState(true);
 const [grouping,setGrouping]=useState<'none'|'months'|'weeks'>('weeks');
 const [questionRange,setQuestionRange]=useState<{from:string;to:string}|null>(null);
 const [sort,setSort]=useState<{column:'correct'|'wrong';direction:'asc'|'desc'}>({column:'wrong',direction:'desc'});
 const [range,setRange]=useState<{from:string;to:string}|null>(null);
 // Convert local calendar boundaries separately so DST days keep their actual length.
 const timelineQuery='/api/statistics/linear?paged=1'+periodQuery(questionRange);
 const timeline=usePages<TimelinePage,Event>(timelineQuery,timelineItems);
 const topicQuery=`/api/statistics/topics?filter=all&sort=${sort.column}&direction=${sort.direction}${periodQuery(range)}`;
 const topics=usePages<TopicsPage,TopicRow>(topicQuery,topicItems);
 const [active,setActive]=useState<{event:Event;left:number;top:number;number:number}|null>(null);
 const popup=useRef<HTMLDivElement>(null);
 const trigger=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{if(!active)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape'){trigger.current?.focus();setActive(null);}};const outside=(e:PointerEvent)=>{if(!popup.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setActive(null);};const resized=()=>setActive(null);document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);window.addEventListener('resize',resized);return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resized);};},[active]);
 function show(event:Event,index:number,button:HTMLButtonElement){trigger.current=button;const r=button.getBoundingClientRect();setActive({event,number:index+1,left:Math.max(12,Math.min(r.left,window.innerWidth-Math.min(560,window.innerWidth-24)-12)),top:Math.max(12,Math.min(r.bottom+8,window.innerHeight-340))});}
 function loadOnScroll(e:React.UIEvent<HTMLDivElement>,more:()=>void){setActive(null);if(e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<150)void more();}
 function sortBy(column:'correct'|'wrong'){setSort(current=>({column,direction:current.column===column&&current.direction==='desc'?'asc':'desc'}));}

 return <main className="statistics-page"><header className="statistics-page-header"><button className="statistics-back library-back" onClick={onBack}>{t("‹ Learning dashboard")}</button><h1>{t("Statistics")}</h1></header><div className="statistics-panels">
  <section className={`statistics-panel ${questionsOpen?'expanded':'collapsed'}`}><div className="statistics-panel-heading"><button className="statistics-accordion" aria-expanded={questionsOpen} aria-controls="question-statistics" onClick={()=>{setActive(null);setQuestionsOpen(!questionsOpen);}}><span>{questionsOpen?'⌄':'›'}</span><h2>{t("By question")}</h2></button>{questionsOpen&&<div className="question-statistics-controls"><MonthCalendar days={topics.page?.days??[]} range={questionRange} onChange={value=>{setActive(null);setQuestionRange(value);}} arbitrary/><label className="month-group-toggle"><span className="sr-only">{t("Question grouping")}</span><select aria-label={t("Question grouping")} value={grouping} onChange={e=>setGrouping(e.target.value as typeof grouping)}><option value="none">{t("None")}</option><option value="months">{t("By month")}</option><option value="weeks">{t("By week")}</option></select></label></div>}</div>{questionsOpen&&<><p className="linear-summary" aria-live="polite">{t("Questions:")}{" "}{timeline.page?.total??'…'} · <span className="linear-good-text">{t("Correct:")}{" "}{ratio(timeline.page?.correct??0,timeline.page?.total??0)} ({timeline.page?.correct??0})</span> · <span className="linear-bad-text">{t("Incorrect:")}{" "}{ratio((timeline.page?.total??0)-(timeline.page?.correct??0),timeline.page?.total??0)} ({(timeline.page?.total??0)-(timeline.page?.correct??0)})</span></p><div key={timelineQuery} id="question-statistics" className="statistics-scroll question-statistics-scroll" tabIndex={0} aria-label={t("Question history")} onScroll={e=>loadOnScroll(e,timeline.more)}>{timeline.rows.map((event,index)=>{const month=questionGroup(event.answered_at,grouping,locale);const previous=index?questionGroup(timeline.rows[index-1].answered_at,grouping,locale):'';return <div key={event.id}>{month&&month!==previous&&<h3 className="statistics-month-heading">{month}</h3>}<QuestionHistoryRow event={event} index={index} onOpen={show}/></div>;})}{timeline.loading&&<Loading/>}{timeline.error&&<p role="alert">{t(timeline.error)} <button onClick={()=>void timeline.more()}>{t("Retry")}</button></p>}{!timeline.loading&&!timeline.error&&!timeline.rows.length&&<p>{t("No saved answers yet.")}</p>}</div></>}
  </section>
  <section className={`statistics-panel ${topicsOpen?'expanded':'collapsed'}`}><div className="statistics-panel-heading"><button className="statistics-accordion" aria-expanded={topicsOpen} aria-controls="topic-statistics" onClick={()=>setTopicsOpen(!topicsOpen)}><span>{topicsOpen?'⌄':'›'}</span><h2>{t("By topic")}</h2></button>{topicsOpen&&<MonthCalendar days={topics.page?.days??[]} range={range} onChange={setRange}/>}</div>{topicsOpen&&<><div key={topicQuery} id="topic-statistics" className="statistics-scroll statistics-topic-scroll" tabIndex={0} aria-label={t("Results by topic")} onScroll={e=>loadOnScroll(e,topics.more)}><table><thead><tr><th scope="col">{t("Topic")}</th><th scope="col" className="statistics-train-column"><span className="sr-only">{t("Go to topic")}</span></th><th scope="col">{t("Total")}</th><SortColumns sort={sort} onSort={sortBy}/></tr></thead><tbody>{topics.rows.map(row=><tr key={row.topic}><th scope="row">{row.topic}</th><td className="statistics-train-column">{row.topic_id&&<button className="statistics-topic-link" title={t("Open topic in the learning dashboard")} aria-label={t('Practice: {topic}', {topic:row.topic})} onClick={()=>onOpenTopic(row.topic_id!)}>↗</button>}</td><ResultCells row={row}/></tr>)}</tbody></table>{topics.loading&&<Loading/>}{topics.error&&<p role="alert">{t(topics.error)} <button onClick={()=>void topics.more()}>{t("Retry")}</button></p>}{!topics.loading&&!topics.error&&!topics.rows.length&&<p>{t("No topic answers in the selected period.")}</p>}</div></>}
  </section>
 </div>{active&&createPortal(<div ref={popup} role="dialog" aria-label={t('Answer {number}', {number:active.number})} className="linear-popover" style={{left:active.left,top:active.top,maxHeight:`calc(100dvh - ${active.top+12}px)`}}><header><div><time dateTime={active.event.answered_at}>{new Date(active.event.answered_at).toLocaleString(locale)}</time><p>{active.event.topic}{active.event.mode==='mistakes'?t(" · Mistake review"):''}</p></div><button aria-label={t("Close question")} onClick={()=>{trigger.current?.focus();setActive(null);}}>×</button></header>{active.event.image_url&&<img src={active.event.image_url} alt={t("Question illustration")}/>}<h3><QuestionText text={active.event.question} translations={active.event.translations} /></h3><div className="linear-answers">{active.event.answers.map(a=><div key={a.letter} className={`linear-answer ${a.correct?'right':a.selected?'wrong':''}`}><b>{a.letter}</b><span><QuestionText text={a.text} translations={a.translations} answer />{a.selected&&<small>{t("Your answer")}</small>}</span><strong>{a.correct?'✓':a.selected?'×':''}</strong></div>)}</div><p className={active.event.correct?'linear-good-text':'linear-bad-text'}>{active.event.correct?t("✓ Correct"):t("× Incorrect")}</p>{Object.values(active.event.help ?? {}).some(Boolean)&&<details><summary>{t("Explanation")}</summary><p className="linear-help"><QuestionText text={Object.values(active.event.help).find(Boolean) || ''} translations={active.event.help}/></p></details>}</div>,document.body)}</main>;
}

export function ReleaseDetails() {
  const t = useT();
  const { preferences } = usePreferences();
  const locale = preferences.interfaceLanguage === 'ru' ? 'ru-RU' : preferences.interfaceLanguage === 'es' ? 'es-ES' : 'en-GB';
  const version = import.meta.env.VITE_APP_VERSION || 'dev';
  const [build, setBuild] = useState<BuildMetadata>({});
  const [releases, setReleases] = useState<ReleaseMetadata[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/version.json', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : {})
      .then(data => { if (!controller.signal.aborted && data && typeof data === 'object') setBuild(data); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/releases', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : [])
      .then(data => { if (!controller.signal.aborted && Array.isArray(data)) setReleases(data); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const release = releases.find(item => item.version === version);
  const stamp = releaseStamp(version, build, release);
  const commit = build.version === version && /^[a-f0-9]{40}$/.test(build.commit ?? '') ? build.commit!.slice(0, 12) : '';
  return <span className="release-details" tabIndex={0} aria-label={t('Application version {version}', { version })}>
    <span className="app-version">{version}</span>
    <span className="release-tooltip" role="tooltip">
      <strong>{t('Version')} {version}</strong>
      {stamp ? <time dateTime={stamp.at}>{t(stamp.label)}: {new Date(stamp.at).toLocaleString(locale)}</time> : version === 'dev' ? <span>{t('Local version')}</span> : null}
      {commit && <code>{t('Commit')}: {commit}</code>}
      {!!release?.changes?.length && <ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>}
    </span>
  </span>;
}
