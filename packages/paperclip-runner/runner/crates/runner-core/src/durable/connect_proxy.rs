//! Explicit CONNECT support for host-owned isolated runner configurations.
//! No ambient HTTPS_PROXY/ALL_PROXY, credentials, redirects or destination DNS.
use std::io::{self, Read, Write};
use std::net::{IpAddr, TcpStream};
use std::time::Instant;

pub(super) const ENV: &str = "PAPERCLIP_RUNNER_CONNECT_PROXY";
const MAX_HEADER: usize = 8192;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn valid_dns(host: &str) -> bool {
    host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn authority(input: &str, default_port: Option<u16>) -> io::Result<(String, u16)> {
    if input.is_empty()
        || input.len() > 320
        || !input.is_ascii()
        || input
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        || input.contains(['@', '%', '/', '?', '#', '\\'])
    {
        return Err(invalid("CONNECT authority is malformed"));
    }
    let (host, port) = if let Some(rest) = input.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| invalid("invalid IPv6 authority"))?;
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| invalid("invalid IPv6 host"))?;
        (
            host,
            suffix
                .strip_prefix(':')
                .or_else(|| if suffix.is_empty() { None } else { Some("") }),
        )
    } else {
        let (host, port) = input
            .rsplit_once(':')
            .map_or((input, None), |(h, p)| (h, Some(p)));
        if !valid_dns(host) || host.contains(':') {
            return Err(invalid("invalid CONNECT host"));
        }
        (host, port)
    };
    let port = match port {
        Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
            let port = value
                .parse::<u16>()
                .map_err(|_| invalid("invalid CONNECT port"))?;
            if port == 0 || value != port.to_string() {
                return Err(invalid("noncanonical CONNECT port"));
            }
            port
        }
        None => default_port.ok_or_else(|| invalid("explicit proxy port is required"))?,
        _ => return Err(invalid("invalid CONNECT port")),
    };
    Ok((host.to_ascii_lowercase(), port))
}

pub(super) fn parse_proxy(input: &str) -> io::Result<(String, u16)> {
    let rest = input
        .strip_prefix("http://")
        .ok_or_else(|| invalid("runner proxy must use http://"))?;
    // No URL path, including slash: this is a bounded endpoint, not a general URL.
    authority(rest, None)
}

pub(super) fn destination(input: &str, port: u16) -> io::Result<String> {
    let (host, parsed_port) = authority(input, Some(port))?;
    if parsed_port != port
        || port != 443
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || (!host.contains('.') && !host.contains(':'))
    {
        return Err(invalid(
            "runner proxy requires a public WSS destination on port 443",
        ));
    }
    // Gateway owns public DNS validation and address pinning. Never resolve the target here.
    // Literals are excluded to avoid bypassing that hostname allowlist/public-DNS boundary.
    if host.parse::<IpAddr>().is_ok() || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(invalid("runner proxy destination must be a DNS hostname"));
    }
    Ok(format!("{host}:{port}"))
}

fn remaining(deadline: Instant) -> io::Result<std::time::Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "CONNECT deadline elapsed",
        ));
    }
    Ok(remaining)
}

pub(super) fn establish(stream: &mut TcpStream, target: &str, deadline: Instant) -> io::Result<()> {
    // Revalidate before interpolating any bytes into the request.
    let target = destination(target, 443)?;
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
    let mut bytes = request.as_bytes();
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let count = stream.write(bytes)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "CONNECT write failed",
            ));
        }
        bytes = &bytes[count..];
    }
    let mut header = Vec::with_capacity(256);
    // Read exactly through CRLFCRLF: a buffered reader could swallow tunnel/TLS bytes.
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= MAX_HEADER {
            return Err(invalid("CONNECT response headers exceed limit"));
        }
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte)?;
        header.push(byte[0]);
    }
    validate_response(&header)?;
    // TLS server cannot legitimately send bytes before the client's ClientHello.
    // Refuse an already queued body; delayed contamination fails TLS authentication.
    stream.set_nonblocking(true)?;
    let peek = stream.peek(&mut [0u8; 1]);
    stream.set_nonblocking(false)?;
    match peek {
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        Ok(0) => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "CONNECT tunnel closed",
            ))
        }
        Ok(_) => return Err(invalid("unexpected data after CONNECT headers")),
        Err(error) => return Err(error),
    }
    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    remaining(deadline)?;
    Ok(())
}

fn validate_response(header: &[u8]) -> io::Result<()> {
    if header.len() > MAX_HEADER || !header.ends_with(b"\r\n\r\n") || !header.is_ascii() {
        return Err(invalid("invalid CONNECT response"));
    }
    let text = std::str::from_utf8(header).map_err(|_| invalid("invalid CONNECT response"))?;
    let mut lines = text[..text.len() - 4].split("\r\n");
    let status = lines
        .next()
        .ok_or_else(|| invalid("missing CONNECT status"))?;
    let status = status
        .strip_prefix("HTTP/1.1 200")
        .or_else(|| status.strip_prefix("HTTP/1.0 200"))
        .ok_or_else(|| invalid("CONNECT proxy did not return 200"))?;
    if !status.starts_with(' ') || status.bytes().any(|b| b.is_ascii_control()) {
        return Err(invalid("invalid CONNECT status"));
    }
    for (index, line) in lines.enumerate() {
        if index >= 64 {
            return Err(invalid("too many CONNECT headers"));
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("invalid CONNECT header"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.bytes().any(|b| b.is_ascii_control() && b != b'\t')
        {
            return Err(invalid("invalid CONNECT header"));
        }
        if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err(invalid("CONNECT response must not declare a body"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn endpoint_and_target_parsing_reject_ambiguity() {
        assert_eq!(
            parse_proxy("http://factory-gateway:3128").unwrap(),
            ("factory-gateway".into(), 3128)
        );
        assert_eq!(
            parse_proxy("http://[::1]:3128").unwrap(),
            ("::1".into(), 3128)
        );
        for value in [
            "https://proxy:3128",
            "http://user:pass@proxy:3128",
            "http://proxy:3128/",
            "http://proxy:0",
            "http://proxy:03128",
            "http://proxy:3128?x",
            "http://proxy:3128\r\nX: y",
            "http://proxy",
            "http://[::1]bad:3128",
            "http://proxy%2e:3128",
            "http://proxy:3128#x",
        ] {
            assert!(parse_proxy(value).is_err(), "{value:?}");
        }
        assert_eq!(
            destination("Factory.Mereka.io", 443).unwrap(),
            "factory.mereka.io:443"
        );
        assert_eq!(
            destination("factory.mereka.io:443", 443).unwrap(),
            "factory.mereka.io:443"
        );
        for value in [
            "127.0.0.1",
            "[::1]",
            "localhost",
            "a.localhost",
            "factory-gateway",
            "127.000.000.001",
            "factory.mereka.io:80",
            "factory.mereka.io:0443",
            "user@factory.mereka.io",
            "factory.mereka.io\r\nX: y",
            "factory.mereka.io.",
        ] {
            assert!(destination(value, 443).is_err(), "{value:?}");
        }
        assert!(destination("factory.mereka.io", 8443).is_err());
    }

    #[test]
    fn response_parser_rejects_status_body_and_injection() {
        assert!(validate_response(
            b"HTTP/1.1 200 Connection established\r\nProxy-Agent: fixture\r\n\r\n"
        )
        .is_ok());
        for value in [
            &b"HTTP/1.1 302 redirect\r\nLocation: https://other\r\n\r\n"[..],
            &b"HTTP/1.1 2000 OK\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\n folded: value\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nBad : value\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nX: value\nInjected: value\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\nX: \x00\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\r\n\r\nbody"[..],
        ] {
            assert!(validate_response(value).is_err(), "{value:?}");
        }
        let many = format!("HTTP/1.1 200 OK\r\n{}\r\n", "X: y\r\n".repeat(65));
        assert!(validate_response(many.as_bytes()).is_err());
    }

    fn local_proxy<F: FnOnce(TcpStream) + Send + 'static>(
        respond: F,
    ) -> (TcpStream, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() <= 256);
            }
            assert_eq!(
                request,
                b"CONNECT factory.mereka.io:443 HTTP/1.1\r\nHost: factory.mereka.io:443\r\n\r\n"
            );
            respond(stream);
        });
        (TcpStream::connect(addr).unwrap(), server)
    }

    #[test]
    fn fragmented_response_preserves_tunnel_bytes_and_connect_target() {
        let (mut stream, server) = local_proxy(|mut stream| {
            for fragment in [
                "HTTP/1.1 2",
                "00 Connec",
                "tion established\r\n",
                "Proxy-Agent: test\r\n",
                "\r\n",
            ] {
                stream.write_all(fragment.as_bytes()).unwrap();
                thread::sleep(Duration::from_millis(2));
            }
            let mut hello = [0; 5];
            stream.read_exact(&mut hello).unwrap();
            assert_eq!(&hello, b"hello");
            stream.write_all(b"reply").unwrap();
        });
        establish(
            &mut stream,
            "factory.mereka.io:443",
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        stream.write_all(b"hello").unwrap();
        let mut reply = [0; 5];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"reply");
        server.join().unwrap();
    }

    #[test]
    fn local_proxy_rejects_oversize_non200_declared_body_drop_and_trailing_bytes() {
        for response in [
            b"HTTP/1.1 403 Forbidden\r\n\r\n".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx".to_vec(),
            b"HTTP/1.1 200 OK\r\n\r\nunexpected-body".to_vec(),
            b"HTTP/1.1 200 OK\r\nX: incomplete".to_vec(),
            format!("HTTP/1.1 200 OK\r\nX: {}", "x".repeat(MAX_HEADER)).into_bytes(),
        ] {
            let (mut stream, server) = local_proxy(move |mut stream| {
                let _ = stream.write_all(&response);
            });
            assert!(establish(
                &mut stream,
                "factory.mereka.io:443",
                Instant::now() + Duration::from_secs(2)
            )
            .is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn local_proxy_slow_drip_consumes_total_deadline() {
        let (mut stream, server) = local_proxy(|mut stream| {
            for byte in b"HTTP/1.1 200 OK\r\n\r\n" {
                if stream.write_all(&[*byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
        });
        let started = Instant::now();
        assert!(establish(
            &mut stream,
            "factory.mereka.io:443",
            started + Duration::from_millis(60)
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_millis(250));
        drop(stream);
        server.join().unwrap();
    }
}
