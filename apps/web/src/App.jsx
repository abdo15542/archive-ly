import {useEffect,useState} from 'react';
import {Archive,Search,Upload,FileText,Folder,ShieldCheck,LogOut,RefreshCw,Plus} from 'lucide-react';

const API=import.meta.env.VITE_API_URL||'http://localhost:4000';
export default function App(){
 const [token,setToken]=useState(localStorage.getItem('archive_token')||'');
 const [email,setEmail]=useState('');
 const [password,setPassword]=useState('');
 const [name,setName]=useState('');
 const [register,setRegister]=useState(false);
 const [documents,setDocuments]=useState([]);
 const [query,setQuery]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [uploadOpen,setUploadOpen]=useState(false);
 const [title,setTitle]=useState('');
 const [file,setFile]=useState(null);
 const [stats,setStats]=useState({total:0});
 const [selectedDoc,setSelectedDoc]=useState(null);\n const [ocrDraft,setOcrDraft]=useState('');
 async function request(path,options={}){
  const response=await fetch(API+path,{...options,headers:{...(options.headers||{}),...(token?{Authorization:'Bearer '+token}:{})}});
  const data=response.status===204?{}:await response.json();
  if(!response.ok)throw new Error(data.error||'تعذر تنفيذ الطلب');
  return data;
 }
 async function load(){
  try{const data=await request('/api/documents?q='+encodeURIComponent(query));setDocuments(data.documents||[]);setStats({total:data.pagination?.total||0});setError('');}
  catch(e){setError(e.message);}
 }
 useEffect(()=>{if(token)load();},[token,query]);
 async function auth(e){
  e.preventDefault();setBusy(true);setError('');
  try{
   const data=await request('/api/auth/'+(register?'register':'login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(register?{fullName:name,email,password}:{email,password})});
   localStorage.setItem('archive_token',data.token);setToken(data.token);
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function openDocument(id){try{const data=await request('/api/documents/'+id);setSelectedDoc(data.document);setOcrDraft(data.document.extracted_text||'');}catch(e){setError(e.message);}}\n async function saveOcr(){try{await request('/api/documents/'+selectedDoc.id+'/ocr',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:ocrDraft})});await openDocument(selectedDoc.id);await load();}catch(e){setError(e.message);}}
 async function uploadDoc(e){
  e.preventDefault();if(!file)return;
  setBusy(true);
  try{const body=new FormData();body.append('title',title);body.append('file',file);await request('/api/documents',{method:'POST',body});setUploadOpen(false);setTitle('');setFile(null);await load();}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 function logout(){localStorage.removeItem('archive_token');setToken('');setDocuments([]);setSelectedDoc(null);}
 if(!token)return <main className="auth-shell"><section className="auth-card"><div className="brand-mark"><Archive size={28}/></div><p className="eyebrow">ARCHIVE LY</p><h1>نظام الأرشفة الإلكترونية</h1><p className="muted">احفظ وثائقك، نظمها، وابحث فيها من مكان واحد.</p><form onSubmit={auth} className="stack">{register&&<label>الاسم الكامل<input required value={name} onChange={e=>setName(e.target.value)} /></label>}<label>البريد الإلكتروني<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} /></label><label>كلمة المرور<input type="password" required minLength={register?10:1} value={password} onChange={e=>setPassword(e.target.value)} /></label><button disabled={busy}>{busy?'جارٍ المعالجة...':register?'إنشاء حساب المسؤول الأول':'تسجيل الدخول'}</button></form><button className="link-btn" onClick={()=>setRegister(!register)}>{register?'لديك حساب؟ تسجيل الدخول':'أول استخدام؟ إنشاء حساب المسؤول الأول'}</button>{error&&<p className="error">{error}</p>}</section></main>;
 return <div className="layout"><aside className="sidebar"><div className="brand"><span className="brand-mark"><Archive/></span><div><b>أرشيف</b><small>ARCHIVE LY</small></div></div><nav><a className="active"><FileText size={18}/> الوثائق</a><a><Folder size={18}/> التصنيفات</a><a><ShieldCheck size={18}/> سجل العمليات</a></nav><div className="side-bottom"><span className="muted">إدارة الوثائق بأمان</span><button className="logout" onClick={logout}><LogOut size={17}/> خروج</button></div></aside><main className="content"><header><div><p className="eyebrow">مساحة العمل</p><h1>مكتبة الوثائق</h1><p className="muted">إدارة وأرشفة المستندات الرقمية</p></div><button onClick={()=>setUploadOpen(true)}><Plus size={18}/> إضافة وثيقة</button></header><section className="stats"><article><span>إجمالي الوثائق</span><strong>{stats.total}</strong><FileText/></article><article><span>بحث داخل الأرشيف</span><strong>فوري</strong><Search/></article><article><span>حماية الوصول</span><strong>مفعّلة</strong><ShieldCheck/></article></section><div className="toolbar"><div className="search"><Search size={18}/><input placeholder="ابحث بالعنوان أو الرقم أو النص..." value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="secondary" onClick={load}><RefreshCw size={16}/> تحديث</button></div>{error&&<p className="error notice">{error}</p>}<section className="table-wrap"><div className="table-head"><b>الوثائق المؤرشفة</b><span>{documents.length} نتيجة</span></div>{documents.length?<div className="doc-list">{documents.map(doc=><article className="doc-row" key={doc.id}><div className="file-icon"><FileText/></div><button className="doc-info doc-open" onClick={()=>openDocument(doc.id)}><b>{doc.title}</b><small>{doc.document_number||'دون رقم'} · {doc.original_name}</small></button><span className={'status status-'+doc.ocr_status}>{doc.ocr_status==='completed'?'اكتمل OCR':doc.ocr_status==='failed'?'فشل OCR':doc.ocr_status==='processing'?'جارٍ الاستخراج':'بانتظار OCR'}</span><a href={API+'/api/documents/'+doc.id+'/file'} target="_blank" rel="noreferrer" onClick={e=>{e.preventDefault();fetch(API+'/api/documents/'+doc.id+'/file',{headers:{Authorization:'Bearer '+token}}).then(r=>r.blob()).then(b=>window.open(URL.createObjectURL(b),'_blank'));}}>فتح الملف</a></article>)}</div>:<div className="empty"><Archive size={34}/><b>لا توجد وثائق بعد</b><span>ابدأ بإضافة أول وثيقة إلى الأرشيف.</span><button onClick={()=>setUploadOpen(true)}><Upload size={16}/> رفع وثيقة</button></div>}</section></main>{selectedDoc&&<div className="modal-backdrop" onClick={()=>setSelectedDoc(null)}><section className="modal detail-modal" onClick={e=>e.stopPropagation()}><button type="button" className="close" onClick={()=>setSelectedDoc(null)}>×</button><h2>{selectedDoc.title}</h2><p className="muted">{selectedDoc.original_name} · حالة OCR: {selectedDoc.ocr_status}</p><h3>النص المستخرج</h3><textarea className="ocr-editor" value={ocrDraft} onChange={e=>setOcrDraft(e.target.value)} placeholder="سيظهر النص المستخرج هنا، ويمكنك تصحيحه يدوياً..." rows={12}/><div className="modal-actions"><button onClick={saveOcr}>حفظ النص المصحح</button><button className="secondary" onClick={()=>openDocument(selectedDoc.id)}><RefreshCw size={16}/> تحديث</button></div></section></div>}{uploadOpen&&<div className="modal-backdrop"><form className="modal stack" onSubmit={uploadDoc}><button type="button" className="close" onClick={()=>setUploadOpen(false)}>×</button><h2>إضافة وثيقة جديدة</h2><label>عنوان الوثيقة<input required minLength={2} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>الملف (PDF أو صورة)<input type="file" accept="application/pdf,image/jpeg,image/png,image/tiff" required onChange={e=>setFile(e.target.files?.[0]||null)}/></label><p className="muted">الحد الأقصى الافتراضي 30 ميغابايت.</p><button disabled={busy}>{busy?'جارٍ الرفع...':'حفظ الوثيقة'}</button></form></div>}</div>;
}
