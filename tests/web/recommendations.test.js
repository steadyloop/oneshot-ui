import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, gpaMatches, isTracked, visibleJobs } from '../../web/recommendations/core.js';

const rows = [
  {id:1,aliases:[11],rank:1,view:'ready',fit:1,company:'Backend Co',title:'Infrastructure Intern',category:'Infrastructure',term:'Winter / Spring 2027',skills:['python','postgresql'],reason:'Transactional workers',apply_url:'https://example.com/1'},
  {id:2,rank:2,view:'ready',fit:2,company:'Systems Co',title:'SWE Intern',category:'General SWE',term:'Summer 2027',skills:['java'],reason:'Engineering internship'},
  {id:3,rank:3,view:'conditional',fit:1,company:'Later Co',title:'Backend Intern',category:'Backend',term:'Summer 2027',conditions:['Extend graduation to May 2028']},
  {id:4,view:'unverified',company:'Undated Co',title:'Intern',term:'Unspecified'},
];
const filters = {view:'ready',search:'',category:'',term:'',fit:'',hideApplied:true};

test('ranked queue preserves order while narrowing role, term and skill and hiding duplicate tracked postings',() => {
  assert.deepEqual(visibleJobs(rows,filters).map(j=>j.rank),[1,2]);
  assert.deepEqual(visibleJobs(rows,{...filters,search:'backend python',term:'winter'}).map(j=>j.id),[1]);
  assert.deepEqual(visibleJobs(rows,filters,[{job_id:11}]).map(j=>j.id),[2]);
  assert.deepEqual(visibleJobs(rows,{...filters,hideApplied:false},[{job_id:11}]).map(j=>j.id),[1,2]);
  assert.deepEqual(visibleJobs(rows,{...filters,view:'conditional'}).map(j=>j.id),[3]);
});

test('manual applications with the same saved employer URL are already tracked',() => {
  assert.equal(isTracked(rows[0],[{id:'manual',job_id:null,apply_url_snapshot:'https://example.com/1'}]),true);
  assert.equal(isTracked(rows[0],[{job_id:2}]),false);
});

test('GPA filtering keeps all roles by default and separates mandatory minimums from preferences',() => {
  const preferred = {gpa_min:null,gpa_preferred:3.7};
  const above = {gpa_min:3.5};
  assert.equal(gpaMatches(above,''),true);
  assert.equal(gpaMatches(above,'higher'),true);
  assert.equal(gpaMatches(above,'compatible'),false);
  assert.equal(gpaMatches(preferred,'compatible'),true);
  assert.equal(gpaMatches(preferred,'none'),true);
  assert.equal(gpaMatches(preferred,'required'),false);
  assert.equal(gpaMatches({gpa_min:3.4},'compatible'),true);
});

test('CSV exports all filtered records with conditions and safely escapes spreadsheet values',() => {
  const text = csv([{rank:1,company:'=HYPERLINK("bad")',title:'Backend, intern',conditions:['Extend graduation','Confirm start'],apply_url:'https://example.com'}]);
  assert.match(text,/"'=HYPERLINK\(""bad""\)"/);
  assert.match(text,/"Backend, intern"/);
  assert.match(text,/"Extend graduation; Confirm start"/);
});
