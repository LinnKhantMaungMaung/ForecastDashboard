#!/usr/bin/env python3
"""
MPP extractor using MPXJ — reads task names, dates, durations, resources.
Requires: pip install mpxj jpype1
MPXJ JARs must be in server/mpxj/ directory.
Usage: python3 mpp_extract.py <file.mpp>
"""
import sys, json, os, glob

def extract_with_mpxj(filepath):
    jar_dir = os.path.join(os.path.dirname(__file__), 'mpxj')
    jars    = glob.glob(os.path.join(jar_dir, '*.jar')) + \
              glob.glob(os.path.join(jar_dir, 'lib', '*.jar'))

    if not jars:
        return None, 'MPXJ JARs not found in server/mpxj/'

    try:
        import jpype, jpype.imports
        if not jpype.isJVMStarted():
            # Suppress Log4j2 warning about missing log4j-core
            import os as _os
            _os.environ['LOG4J_FORMAT_MSG_NO_LOOKUPS'] = 'true'
            jpype.startJVM(classpath=jars, convertStrings=True,
                           jvmargs=['-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory',
                                    '-Dorg.slf4j.simpleLogger.defaultLogLevel=off',
                                    '-Dlog4j.defaultInitOverride=true'])

        from net.sf.mpxj.reader import UniversalProjectReader
        from net.sf.mpxj import TimeUnit
        import java.io.File as JFile

        project   = UniversalProjectReader().read(JFile(filepath))
        tasks_out = []

        for t in project.getTasks():
            if t.getID() is None or int(t.getID()) == 0: continue
            name = str(t.getName()) if t.getName() else ''
            if not name.strip(): continue

            dur_h = 0.0
            dur   = t.getDuration()
            if dur:
                try:
                    dur_h = float(dur.convertUnits(
                        TimeUnit.HOURS,
                        project.getProjectProperties()
                    ).getDuration())
                except: pass

            resources = []
            for ra in t.getResourceAssignments():
                if ra.getResource() and ra.getResource().getName():
                    resources.append(str(ra.getResource().getName()))

            tasks_out.append({
                'id':             int(t.getID()),
                'name':           name,
                'outline_level':  int(t.getOutlineLevel()) if t.getOutlineLevel() else 0,
                'is_summary':     bool(t.getSummary()),
                'start':          str(t.getStart())[:10] if t.getStart() else None,
                'finish':         str(t.getFinish())[:10] if t.getFinish() else None,
                'duration_hours': round(dur_h, 1),
                'dur_weeks':      max(1, round(dur_h / 40)) if dur_h > 0 else 1,
                'resources':      resources,
            })

        return {'source': 'mpxj', 'tasks': tasks_out}, None

    except Exception as e:
        return None, str(e)


def extract_strings_fallback(filepath):
    """Fallback: UTF-16 string scan when MPXJ unavailable."""
    try:
        import olefile, struct, re
        NOISE = re.compile(
            r'^(\*|#|\$|%|&|\'|\(|[0-9]|\+|-(?![a-zA-Z])|/)|'
            r'(LINK_|&Gantt|&All|&No |&Entry|Time&|Resource|Gantt|Calendar|'
            r'Network|Project Summary|WBS$|Segoe|Calibri|gbui:|CV_iew|Sprint|'
            r'GBP$|MTI$|FDS$|(?:payment|Quoted Leadtimes|% on ))|'
            r'(EAC:|BCWS:|SV:|VAC:|ACWP:|CWS:|CWP:|W\.Comp:|Milestone Date:|'
            r'Actual Dur:|Remaining Dur:|Work:)$|'
            r'^(Template|Standard|Not Started|Next up|In progress|Done|'
            r'Inactive|Manual\s|Duration-only|Start-only|Finish-only|'
            r'Used for Microsoft|Charles |tasks$|resources$|'
            r'Entry$|All Tasks$|Active Tasks$|No Task Group$|No Resource Group$|'
            r'Task Name$|Max\. Units$|Std\. Rate$|Ovt\. Rate$|Cost/Use$|'
            r'Task Form$|Task Sheet$|Task$|Split$|Milestone$|Summary$|No Group$|'
            r'Timeline$|Cost$|Earned Value$|External$|Inserted Project$|Tracking$|Work$|'
            r'Total Cost:|Fixed:|Actual:|Baseline:|Remaining:|Variance:|BAC:|'
            r'Cost:|CV:|Start:|Finish:|Dur:|Comp:|Actual Start:|Actual Finish:|'
            r'WBS:|Duration:|Res:|Remain:|W\.Comp:)',
            re.I
        )
        ole    = olefile.OleFileIO(filepath)
        seen   = set()
        result = []
        for sp in ole.listdir():
            try:
                data = ole.openstream(sp).read()
            except: continue
            i = 0
            while i < len(data) - 3:
                if 0x20 <= data[i] <= 0x7e and data[i+1] == 0:
                    chars = []
                    j = i
                    while j+1 < len(data) and 0x20 <= data[j] <= 0x7e and data[j+1] == 0:
                        chars.append(chr(data[j])); j += 2
                    if len(chars) >= 3:
                        text = ''.join(chars).strip()
                        if (text and text not in seen and len(text) > 3
                                and sum(c.isalpha() for c in text) >= 2
                                and '\\' not in text and '!' not in text
                                and not re.search(r'[<>{}="@]', text)
                                and not NOISE.search(text)
                                and not re.match(r'^[^a-zA-Z0-9\s]', text)):
                            seen.add(text)
                            result.append(text)
                    i = j
                else:
                    i += 1
        return {'source': 'raw_strings', 'raw_strings': result}, None
    except Exception as e:
        return None, str(e)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: mpp_extract.py <file.mpp>'}))
        sys.exit(1)

    filepath = sys.argv[1]

    # Try MPXJ first
    result, err = extract_with_mpxj(filepath)
    if result:
        print(json.dumps(result))
        sys.exit(0)

    print(f'[mpp_extract] MPXJ failed ({err}), falling back to string scan', file=sys.stderr)

    # Fallback to string scan
    result, err = extract_strings_fallback(filepath)
    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({'error': err or 'Could not parse MPP file'}))
