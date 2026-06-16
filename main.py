import io
import fitz
import unicodedata as uni
import re
import json
from collections import defaultdict
from flask import Flask, render_template, request, jsonify
from gliner import GLiNER

app = Flask(__name__)

model_large = GLiNER.from_pretrained("knowledgator/gliner-multitask-large-v0.5")
model_nuner = GLiNER.from_pretrained("numind/NuNER_Zero")

BASE_LABELS = [
    "job title", "company name", "university degree or major", 
    "technical skill", "programming language", "software framework or library",
    "certification or license", "years or months of experience", "contact",
    "soft skill or personal trait"
]

BLOCKLIST = {
    "company name", "company", "employer", "organization name", 
    "city, state", "city, st", "your name", "first name", "last name",
    "job title", "position", "lorem ipsum", "skills", "skill"
}

def extractPDF(pdf_bytes: str) -> str:
  stream = io.BytesIO(pdf_bytes) 
  doc = fitz.open(stream=stream, filetype="pdf")
  text = ""
  for page in doc:
    text += page.get_text()
  return text

def normalize(text: str) -> str:
  text = uni.normalize("NFKD", text)
  text = text.replace('\r\n', '\n').replace('\r', '\n')
  text = text.encode("ascii", "ignore").decode("ascii")
  text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    
  return text


def cleanText(text: str) -> str:
  text = re.sub(r'\bPage\s+\d+\s*(of\s*\d+)?\b', '', text, flags=re.IGNORECASE)
  text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
  text = re.sub(r'\n{3,}', '\n\n', text)
  text = re.sub(r'[ \t]+', ' ', text)
  return text.strip()

def buildJSON(entities: list[dict], resumeFile: str) -> dict:
  grouped = defaultdict(list)
  for entity in entities:
    text = entity["text"].strip()
    if text.lower() in BLOCKLIST:
      continue
    grouped[entity["label"]].append({
        "text": entity["text"],
        "score": round(entity["score"], 4),
        "char_start": entity["start"],
        "char_end": entity["end"],
    })

  return {
      "resume file": resumeFile,
      "entities": dict(grouped)
  }

def run_gliner_chunked(model, text: str, is_nuner=False, chunk_size=300, overlap=75, threshold=0.6):
    word_matches = list(re.finditer(r'\S+', text))
    all_preds = []
    seen = set()
    
    i = 0
    while i < len(word_matches):
        chunk_matches = word_matches[i : i + chunk_size]
        if not chunk_matches: break
            
        chunk_start = chunk_matches[0].start()
        chunk_end = chunk_matches[-1].end()
        chunk_text = text[chunk_start:chunk_end]
        
        entities = model.predict_entities(
            chunk_text, BASE_LABELS, threshold=threshold, flat_ner=False, multi_label=True, max_len=384
        )
        
        for ent in entities:
            base_label = ent["label"]
            abs_start = ent["start"] + chunk_start
            abs_end   = ent["end"]   + chunk_start
            
            key = (base_label, abs_start, abs_end)
            if key not in seen:
                seen.add(key)
                all_preds.append({
                    "label": base_label,
                    "start": abs_start,
                    "end": abs_end,
                    "score": ent["score"]
                })
                
        i += (chunk_size - overlap)
        
    if is_nuner and all_preds:
        all_preds = sorted(all_preds, key=lambda x: x['start'])
        merged, current = [], all_preds[0].copy()
        for next_ent in all_preds[1:]:
            if next_ent['label'] == current['label'] and (next_ent['start'] <= current['end'] + 1):
                current['end'] = max(current['end'], next_ent['end'])
                current['score'] = max(current['score'], next_ent['score'])
            else:
                merged.append(current)
                current = next_ent.copy()
        merged.append(current)
        return merged
        
    return all_preds

def ensemble_predictions(preds_a, preds_b, full_text):
    all_preds = sorted(preds_a + preds_b, key=lambda x: x['start'])
    if not all_preds: return []
    
    combined = []
    current = all_preds[0].copy()
    
    for next_ent in all_preds[1:]:
        if next_ent['label'] == current['label'] and max(current['start'], next_ent['start']) <= min(current['end'], next_ent['end']):
            current['start'] = min(current['start'], next_ent['start'])
            current['end'] = max(current['end'], next_ent['end'])
            current['score'] = max(current['score'], next_ent['score']) # Keep highest confidence
        else:
            current['text'] = full_text[current['start']:current['end']]
            combined.append(current)
            current = next_ent.copy()
            
    current['text'] = full_text[current['start']:current['end']]
    combined.append(current)
    return combined

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/analyze', methods=['POST'])
def analyze():
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
 
    file = request.files['file']
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({"error": "Only PDF files are supported"}), 400
 
    try:
        pdf_bytes = file.read()
        raw_text = extractPDF(pdf_bytes)
        normalized = normalize(raw_text)
        cleaned = cleanText(normalized)
        preds_large = run_gliner_chunked(model_large, cleaned, is_nuner=False)
        preds_nuner = run_gliner_chunked(model_nuner, cleaned, is_nuner=True)
        final_entities = ensemble_predictions(preds_large, preds_nuner, cleaned)
        output = buildJSON(final_entities, file.filename)
        output["text"] = cleaned
 
        return jsonify(output)
 
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
if __name__ == '__main__':
    app.run(debug=True)
