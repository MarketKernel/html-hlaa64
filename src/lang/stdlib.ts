// Files that come with the translator: `include "std/file.hla"` finds them when the project has no
// file of that name (a project's own std/file.hla wins). They are plain HLA64 without register names,
// so the same text works on macOS (libSystem) and Windows (msvcrt.dll).

const FILE_HLA = `// std/file.hla — reading and writing files, the same on macOS and Windows (built into HLA64).
// Built on the C runtime (fopen/fread/fwrite/fclose exist in libSystem and in msvcrt.dll alike);
// files are always opened in binary mode, so Windows does not turn \\n into \\r\\n.
// Results: a byte count, or -1 when the file cannot be opened; file_open returns 0 on failure.
extern fopen, fclose, fread, fwrite, fseek, ftell

// the whole file at once ------------------------------------------------------------------

// reads at most size bytes of the file into buf; the number of bytes read, or -1
fn read_file(path, buf, size) {
    let b = buf
    let n = size
    let f = file_open(path, "r")
    if f == 0 { return -1 }
    let got = fread(b, 1, n, f)
    fclose(f)
    return got
}

// creates or replaces the file with size bytes from buf; the number of bytes written, or -1
fn write_file(path, buf, size) {
    let b = buf
    let n = size
    let f = file_open(path, "w")
    if f == 0 { return -1 }
    let put = fwrite(b, 1, n, f)
    fclose(f)
    return put
}

// adds size bytes from buf at the end of the file (creates it when missing); bytes written, or -1
fn append_file(path, buf, size) {
    let b = buf
    let n = size
    let f = file_open(path, "a")
    if f == 0 { return -1 }
    let put = fwrite(b, 1, n, f)
    fclose(f)
    return put
}

// the size of the file in bytes, or -1 when it cannot be opened (up to 2 GB: C's long is 32-bit on Windows)
fn file_size(path) {
    let f = file_open(path, "r")
    if f == 0 { return -1 }
    fseek(f, 0, 2)                     // SEEK_END
    let size = ftell(f)
    fclose(f)
    return sext32(size)
}

// step by step through a handle --------------------------------------------------------------

// mode "r" read, "w" write (create or truncate), "a" append; a handle, or 0
fn file_open(path, mode) {
    local m: u8[4]
    let p = path
    let md = mode
    m[0] = u8[md]
    m[1] = 'b'                         // binary on every system
    m[2] = 0
    if u8[md + 1] == '+' {
        m[2] = '+'
        m[3] = 0
    }
    return fopen(p, &m)
}

// reads up to size bytes into buf; the number read (0 at the end of the file)
fn file_read(f, buf, size) {
    return fread(buf, 1, size, f)
}

// writes size bytes from buf; the number written
fn file_write(f, buf, size) {
    return fwrite(buf, 1, size, f)
}

// 0 when the data reached the file
fn file_close(f) {
    return sext32(fclose(f))
}
`;

/** built-in files by path */
export const STD_FILES: Record<string, string> = { 'std/file.hla': FILE_HLA };
