#!/usr/bin/env python3
"""
MPP extractor: reads Microsoft Project .mpp files and outputs JSON task list.
Scans OLE2 streams for UTF-16 encoded strings, filters noise, returns tasks.
"""
import sys, json, re

# Noise: view metadata, resource names, payment terms, fragments
NOISE = re.compile(
    r'^(\*|#|\$|%|&|\'|\(|[0-9]|\+|-(?![a-zA-Z])|/)|'
    r'(LINK_|&Gantt|&All|&No |&Entry|Time&|Resource|Gantt|'
    r'Calendar|Network|Project Summary|WBS$|Segoe|Calibri|gbui:|'
    r'CV_iew|Sprint|GBP$|MTI$|FDS$|'
    r'(?:payment|Quoted Leadtimes|% on |on Order|on FDS|on Completion|on Delivery))|'
    r'(ID:|EAC:|BCWS:|SV:|VAC:|ACWP:|CWS:|CWP:|W\.Comp)$|'
    r'^(Template|Standard|Not Started|Next up|In progress|Done|'
    r'Inactive|Manual\s|Duration-only|Start-only|Finish-only|'
    r'Used for Microsoft|Charles |tasks$|resources$|'
    r'Entry$|All Tasks$|Active Tasks$|No Task Group$|No Resource Group$|'
    r'Task Name$|Max\. Units$|Std\. Rate$|Ovt\. Rate$|Cost/Use$|'
    r'Task Form$|Task Sheet$|Task$|Split$|Milestone$|Summary$|No Group$|'
    r'Timeline$|Cost$|Earned Value$|External$|Inserted Project$|Tracking$|Work$|'
    r'Total Cost:|Fixed:|Actual:|Baseline:|Remaining:|Variance:|BAC:|'
    r'Cost:|CV:|Start:|Finish:|Dur:|Comp:|Actual Start:|Actual Finish:|'
    r'WBS:|Duration:|Res:|Remain:|W\.Comp:|Milestone Date:|Actual Dur:|Remaining Dur:|Work:)',
    re.I
)

RESOURCE = re.compile(
    r'^(Design Engineer|Control Systems? Engineer|Procurement$|Panel Shop$|'
    r'Install Team$|Project Manager$|Robotics Engineer|Customer$|Sales$|'
    r'Chris Jones|Jack Edwards|Site Lead$|Service Manager$|'
    r'Holloway Controls|End User$|Tester$|Control System Engineer|'
    r'CCustomer|Conrol System)$',
    re.I
)


def is_task_like(s):
    if len(s) < 3 or len(s) > 150:            return False
    if re.match(r'^[\d\s./:%-]+$', s):         return False
    if '\\' in s or '!' in s:                  return False
    if re.search(r'[<>{}="@]', s):             return False
    if not any(c.isalpha() for c in s):        return False
    if NOISE.search(s):                        return False
    if RESOURCE.search(s):                     return False
    # Fragment check: starts with special char prefix like ')Design' or '-Procurement'
    if re.match(r'^[^a-zA-Z0-9\s]', s):       return False
    # Word fragment: starts lowercase or is a truncated phrase ending mid-word
    if s[0].islower() and len(s) < 10:         return False
    # Partial words: 'roject', 'ing Dur:', 'ctual Start:' etc.
    if re.match(r'^[a-z]{2,}[A-Z\s]', s):     return False
    return True


def extract_from_mpp(filepath):
    try:
        import olefile
    except ImportError:
        return {"error": "olefile not installed. Run: pip install olefile", "tasks": []}
    try:
        ole = olefile.OleFileIO(filepath)
    except Exception as e:
        return {"error": str(e), "tasks": []}

    # Try embedded XML first
    for sp in ole.listdir():
        try:
            data = ole.openstream(sp).read()
            if b"<Project" in data or b"<Tasks>" in data:
                r = parse_mpp_xml(data)
                if r.get('tasks'):
                    return r
        except:
            continue

    # Scan all streams for UTF-16-LE strings
    seen = set()
    strings = []
    for sp in ole.listdir():
        try:
            data = ole.openstream(sp).read()
        except:
            continue
        i = 0
        while i < len(data) - 3:
            if 0x20 <= data[i] <= 0x7e and data[i+1] == 0:
                chars = []
                j = i
                while j + 1 < len(data) and 0x20 <= data[j] <= 0x7e and data[j+1] == 0:
                    chars.append(chr(data[j]))
                    j += 2
                if len(chars) >= 3:
                    text = ''.join(chars).strip()
                    if text and text not in seen:
                        seen.add(text)
                        strings.append(text)
                i = j
            else:
                i += 1

    tasks = [s for s in strings if is_task_like(s)]



    return {
        "tasks":       [],
        "raw_strings": tasks,
        "source":      "raw_strings",
    }


def parse_mpp_xml(xml_bytes):
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(xml_bytes.lstrip(b"\xef\xbb\xbf\xff\xfe\xfe\xff"))
    except ET.ParseError as e:
        return {"error": str(e), "tasks": []}
    ns = {"ms": "http://schemas.microsoft.com/project"}
    def find(el, tag):
        return el.findtext("ms:"+tag, namespaces=ns) or el.findtext(tag) or ""
    tasks, resources, assignments = [], {}, {}
    for res in root.findall(".//ms:Resource", ns) or root.findall(".//Resource"):
        uid = find(res, "UID"); name = find(res, "Name")
        if name and uid: resources[uid] = name
    for asn in root.findall(".//ms:Assignment", ns) or root.findall(".//Assignment"):
        t = find(asn, "TaskUID"); r2 = find(asn, "ResourceUID")
        if t and r2: assignments.setdefault(t, []).append({"resource": resources.get(r2, "Unknown")})
    for task in root.findall(".//ms:Task", ns) or root.findall(".//Task"):
        uid = find(task, "UID"); name = find(task, "Name")
        if not name or uid == "0": continue
        dur_str = find(task, "Duration") or "PT0H0M0S"
        hrs = 0
        m = re.search(r"PT(\d+)H", dur_str)
        if m: hrs += int(m.group(1))
        dm = re.search(r"P(\d+)D", dur_str)
        if dm: hrs += int(dm.group(1)) * 8
        outline = int(find(task, "OutlineLevel") or "0")
        tasks.append({
            "uid": uid, "name": name,
            "start": find(task, "Start")[:10],
            "finish": find(task, "Finish")[:10],
            "duration_hours": hrs,
            "dur_weeks": max(1, round(hrs / 40)) if hrs > 0 else 1,
            "outline_level": outline, "is_summary": outline <= 1,
            "assignments": assignments.get(uid, []),
        })
    return {"tasks": tasks, "resources": list(resources.values()), "source": "xml"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: mpp_extract.py <file.mpp>"}))
        sys.exit(1)
    print(json.dumps(extract_from_mpp(sys.argv[1]), indent=2))
