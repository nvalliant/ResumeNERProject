import io
import fitz
import unicodedata as uni
import re
import json
from collections import defaultdict
from flask import Flask, render_template, request, jsonify
from gliner import GLiNER

app = Flask(__name__)

model = GLiNER.from_pretrained("urchade/gliner_large-v2.1")

entityLabels = [
    "job title",
    "company name",
    "university degree or major",
    "certification or license",
    "years or months of experience",
    "programming language",
    "software framework or library",
    "technical skill",
    "email address or phone number",
    "soft skill or personal trait",
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
  text = uni.normalize("NFKC", text)

  #normalize punct
  text = text.replace('\r\n', '\n').replace('\r', '\n')
    
  text = text.replace('\xa0', ' ')

  text = text.replace("\u200b", "")
    
  text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text)

  text = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", text)
    
  return text


def cleanText(text: str) -> str:
  #remove page numbers
  text = re.sub(r'\bPage\s+\d+\s*(of\s*\d+)?\b', '', text, flags=re.IGNORECASE)
  text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)

  #remove white spaces
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

def chunkedPredict(model, text: str, labels: list, chunk_size=380, overlap=50, threshold=0.1):
    words = text.split()
    all_entities = []
    seen = set()

    i = 0
    char_search_start = 0
    while i < len(words):
        chunk_words = words[i:i + chunk_size]

        # Find real start position of first word
        chunk_start = text.find(chunk_words[0], char_search_start)

        # Find end position by locating each word sequentially
        pos = chunk_start
        for word in chunk_words:
            found = text.find(word, pos)
            if found == -1:
                break
            pos = found + len(word)
        chunk_end = pos

        # Slice directly from original text, preserving all whitespace
        chunk_text = text[chunk_start:chunk_end]

        entities = model.predict_entities(chunk_text, labels, threshold=threshold, flat_ner=False, multi_label=True, max_len=384)

        for ent in entities:
            abs_start = ent["start"] + chunk_start
            abs_end   = ent["end"]   + chunk_start
            key = (ent["label"], abs_start, abs_end)
            if key not in seen:
                seen.add(key)
                ent["start"] = abs_start
                ent["end"]   = abs_end
                all_entities.append(ent)

        char_search_start = chunk_start
        i += chunk_size - overlap

    return all_entities

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
 
        entities = chunkedPredict(model, cleaned, entityLabels)
        output = buildJSON(entities, file.filename)
        output["text"] = cleaned
 
        return jsonify(output)
 
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
if __name__ == '__main__':
    app.run(debug=True)