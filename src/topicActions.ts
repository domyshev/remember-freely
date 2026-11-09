type ReviewRun = {
 id:number;
 kind:'full'|'new';
 wrong:number;
 review_pending?:number;
 completed_at:string|null;
 review?:{completed_at:string|null};
};

// Reviews belong to a particular run. A fresh full repeat starts a new cycle.
export function topicReviewState<T extends ReviewRun>(runs:T[]) {
 const full=runs.find(run=>run.kind==='full');
 const failed=runs.filter(run=>run.id>=(full?.id??0)&&run.completed_at&&run.wrong>0);
 const outstanding=failed.filter(run=>(run.review_pending??(run.review?.completed_at?0:run.wrong))>0);
 const pending=outstanding.find(run=>run.review&&!run.review.completed_at)??outstanding.find(run=>!run.review);
 return {pending,completed:failed.length>0&&outstanding.length===0};
}

type ContinuationProgress={remaining:number;new_count:number;total:number;answered:number;next_question:number};
const questions=(count:number)=>`${count} question${count===1?'':'s'}`;

type Translator = (text:string, values?:Record<string,string|number>)=>string;
export function topicErrorLabel(count:number, t?:Translator) {return t ? t('{count} questions to review', {count}) : `${questions(count)} to review`;}

export function topicContinuation(progress:ContinuationProgress, t?:Translator) {
 const existing=Math.max(0,progress.remaining);
 const added=Math.max(0,progress.new_count);
 const remaining=existing+added;
 if(!remaining)return {
  target:'repeat' as const,
  label:t ? t('Topic completed') : 'Topic completed',
  tooltip:t ? t('All {total} questions answered. Start a new run to practice again; previous results stay in history.', {total:progress.total}) : `You have answered all ${questions(progress.total)}. "Practice topic again" starts a new run. Previous results remain in your history.`,
 };
 if(!existing&&added)return {
  target:'new' as const,
  label:t ? t('Topic completed · {added} new questions', {added}) : `Topic completed · ${added} new question${added===1?'':'s'}`,
  tooltip:t ? t('Practice {added} new questions separately; previous results are preserved.', {added}) : `You have completed this topic. ${questions(added)} added. "Practice new questions" opens only the new questions; previous results are preserved.`,
 };
 const totalSuffix=remaining===progress.total?'':` of ${progress.total}`;
 return {
  target:'main' as const,
  label:t ? t('{remaining} of {total} remaining · {added} new', {remaining,total:progress.total,added}) : added?`${remaining}${totalSuffix} remaining, including ${added} new`:`${questions(remaining)}${totalSuffix} remaining`,
  tooltip:t ? t('Unanswered: {remaining} of {total}. Continue from question {next}; answered questions are skipped. New questions can be practiced separately.', {remaining,total:progress.total,next:progress.next_question}) : `Unanswered: ${questions(remaining)} of ${progress.total}. Continue from question ${progress.next_question}; answered questions are skipped.${added?` Finish the remaining questions in the main run (${existing}), then practice the new questions (${added}) in a separate batch with saved statistics.`:''}`,
 };
}

export function topicReturnState<T extends {expanded:string[]}>(view:T,id:string,nodes:{id:string;parent_id?:string|null}[]) {
 const parents:string[]=[];
 let parent=nodes.find(node=>node.id===id)?.parent_id;
 while(parent&&!parents.includes(parent)) {parents.push(parent);parent=nodes.find(node=>node.id===parent)?.parent_id;}
 return {...view,search:'',expanded:[...new Set([...view.expanded,...parents,id])],recentTopic:id,completedTopic:undefined};
}

// Count practice topics at every depth, rather than treating nested sections as leaves.
export function topicBranchProgress(id:string,nodes:{id:string;parent_id?:string|null}[],summaries:Record<string,{completed:boolean;new_count?:number}>|null) {
 const pending=[id],seen=new Set<string>(),leaves:string[]=[];
 while(pending.length) {
  const current=pending.pop()!;
  if(seen.has(current))continue;
  seen.add(current);
  const children=nodes.filter(node=>node.parent_id===current);
  if(children.length)pending.push(...children.map(node=>node.id));
  else leaves.push(current);
 }
 return {total:leaves.length,completed:leaves.filter(leaf=>summaries?.[leaf]?.completed&&!summaries[leaf].new_count).length};
}
