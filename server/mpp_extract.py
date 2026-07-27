#!/usr/bin/env python3
"""
MPP extractor using MPXJ via pip package.
Install: pip install jpype1 olefile mpxj
No JAR files needed - pip mpxj bundles everything.
Usage: python3 mpp_extract.py <file.mpp>
"""
import sys, json, os, glob


def find_mpxj_jars():
    """Find JARs from pip-installed mpxj package."""
    try:
        import mpxj as mpxj_pkg
        pkg_dir = os.path.dirname(mpxj_pkg.__file__)
        jars = glob.glob(os.path.join(pkg_dir, '**', '*.jar'), recursive=True)
        if jars:
            return jars
    except ImportError:
        pass

    # Fallback: check common pip install locations
    for base in ['/usr/local/lib', '/usr/lib']:
        jars = glob.glob(os.path.join(base, '**/mpxj/**/*.jar'), recursive=True)
        if jars:
            return jars

    # Last resort: local server/mpxj directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_dir  = os.path.join(script_dir, 'mpxj')
    jars = glob.glob(os.path.join(local_dir, '*.jar')) + \
           glob.glob(os.path.join(local_dir, 'lib', '*.jar'))
    return jars


def extract_with_mpxj(filepath):
    jars = find_mpxj_jars()
    if not jars:
        return None, 'MPXJ JARs not found. Run: pip install mpxj jpype1'

    try:
        import jpype
        if not jpype.isJVMStarted():
            # Note: jvmargs are positional in JPype, not a keyword argument
            jpype.startJVM(
                '-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory',
                '-Dorg.slf4j.simpleLogger.defaultLogLevel=off',
                classpath=jars,
                convertStrings=True
            )
        # jpype.imports must be imported AFTER JVM is started
        import jpype.imports

        # pip mpxj 13+ uses org.mpxj; older bundled JARs use net.sf.mpxj
        # Try new package name first, fall back to old
        try:
            from org.mpxj.reader import UniversalProjectReader
            from org.mpxj import TimeUnit
        except Exception:
            from net.sf.mpxj.reader import UniversalProjectReader
            from net.sf.mpxj import TimeUnit
        import java.io.File as JFile

        project    = UniversalProjectReader().read(JFile(filepath))
        tasks_out  = []

        for t in project.getTasks():
            if t.getID() is None or int(t.getID()) == 0:
                continue
            name = str(t.getName()) if t.getName() else ''
            if not name.strip():
                continue

            dur_h = 0.0
            dur   = t.getDuration()
            if dur:
                try:
                    dur_h = float(
                        dur.convertUnits(TimeUnit.HOURS, project.getProjectProperties())
                           .getDuration()
                    )
                except:
                    pass

            resources = []
            for ra in t.getResourceAssignments():
                r = ra.getResource()
                if r and r.getName():
                    resources.append(str(r.getName()))

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
    """UTF-16 string scan fallback when MPXJ unavailable."""
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
            r'WBS:|Duration:|Res:|Remain:|W\.Comp:|Milestone Date:|'
            r'Actual Dur:|Remaining Dur:)',
            re.I
        )
        ole    = olefile.OleFileIO(filepath)
        seen   = set()
        result = []
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
                    while j+1 < len(data) and 0x20 <= data[j] <= 0x7e and data[j+1] == 0:
                        chars.append(chr(data[j]))
                        j += 2
                    if len(chars) >= 3:
                        text = ''.join(chars).strip()
                        if (text and text not in seen
                                and len(text) > 3
                                and sum(c.isalpha() for c in text) >= 2
                                and '\\' not in text
                                and '!' not in text
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

    # Try MPXJ first (full structured data with dates/durations)
    result, err = extract_with_mpxj(filepath)
    if result:
        print(json.dumps(result))
        sys.exit(0)

    print(f'[mpp_extract] MPXJ unavailable ({err}), using string scan fallback', file=sys.stderr)

    # Fallback: extract readable strings from binary
    result, err = extract_strings_fallback(filepath)
    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({'error': err or 'Could not parse MPP file'}))
