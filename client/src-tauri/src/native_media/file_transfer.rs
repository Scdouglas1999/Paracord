use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use paracord_transport::connection::{ConnectionMode, MediaConnection};
use paracord_transport::control::{ControlMessage, StreamFrame, StreamFrameCodec};
use paracord_transport::endpoint::MediaEndpoint;

use super::commands::FileTransferResult;
use super::session::NativeMediaSession;

const CHUNK_SIZE: usize = 256 * 1024; // 256 KiB

/// Upload a file over a QUIC bidi stream.
pub async fn upload_file(
    endpoint_addr: &str,
    token: &str,
    cert_hash: &str,
    transfer_id: &str,
    file_path: &str,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    use tauri::Emitter;

    // Create a fresh QUIC endpoint for this transfer
    let bind_addr: std::net::SocketAddr = "0.0.0.0:0"
        .parse()
        .map_err(|e| format!("bad bind addr: {e}"))?;
    let endpoint = MediaEndpoint::client(bind_addr).map_err(|e| format!("endpoint: {e}"))?;

    let remote_addr = NativeMediaSession::resolve_endpoint_addr(endpoint_addr).await?;

    let connecting = endpoint
        .connect_pinned(remote_addr, "paracord", cert_hash)
        .map_err(|e| format!("QUIC connect: {e}"))?;
    let quinn_conn = connecting
        .await
        .map_err(|e| format!("QUIC handshake: {e}"))?;
    let connection = MediaConnection::connect_and_auth(quinn_conn, token, ConnectionMode::Relay)
        .await
        .map_err(|e| format!("auth: {e}"))?;

    // Open bidi stream
    let (mut send_stream, mut recv_stream) = connection
        .open_bi()
        .await
        .map_err(|e| format!("open_bi: {e}"))?;

    // Send FileTransferInit
    let init_msg = ControlMessage::FileTransferInit {
        transfer_id: transfer_id.to_string(),
        upload_token: token.to_string(),
        resume_offset: None,
    };
    let init_frame = StreamFrame::Control(init_msg);
    let encoded = init_frame
        .encode()
        .map_err(|e| format!("encode init: {e}"))?;
    send_stream
        .write_all(&encoded)
        .await
        .map_err(|e| format!("write init: {e}"))?;

    // Read FileTransferAccept
    let mut codec = StreamFrameCodec::new();
    let mut read_buf = vec![0u8; 4096];
    loop {
        let n = recv_stream
            .read(&mut read_buf)
            .await
            .map_err(|e| format!("read accept: {e}"))?
            .ok_or("stream closed before accept")?;
        codec.feed(&read_buf[..n]);
        if let Some(frame) = codec
            .decode_next()
            .map_err(|e| format!("decode accept: {e}"))?
        {
            match frame {
                StreamFrame::Control(ControlMessage::FileTransferAccept { .. }) => break,
                StreamFrame::Control(ControlMessage::FileTransferReject { reason, .. }) => {
                    return Err(format!("upload rejected: {reason}"));
                }
                _ => continue,
            }
        }
    }

    // Read file and send in chunks
    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("open file: {e}"))?;
    let file_size = file
        .metadata()
        .await
        .map_err(|e| format!("file metadata: {e}"))?
        .len();

    let mut bytes_sent: u64 = 0;
    let mut chunk_buf = vec![0u8; CHUNK_SIZE];

    loop {
        let n = file
            .read(&mut chunk_buf)
            .await
            .map_err(|e| format!("read file: {e}"))?;
        if n == 0 {
            break;
        }

        let data_frame = StreamFrame::Data(Bytes::copy_from_slice(&chunk_buf[..n]));
        let encoded = data_frame
            .encode()
            .map_err(|e| format!("encode data: {e}"))?;
        send_stream
            .write_all(&encoded)
            .await
            .map_err(|e| format!("write data: {e}"))?;

        bytes_sent += n as u64;

        // Emit progress event
        let _ = app.emit(
            "file_transfer_progress",
            serde_json::json!({
                "transfer_id": transfer_id,
                "bytes_sent": bytes_sent,
                "total_bytes": file_size,
            }),
        );
    }

    // Send EndOfData
    let end_frame = StreamFrame::EndOfData;
    let encoded = end_frame.encode().map_err(|e| format!("encode end: {e}"))?;
    send_stream
        .write_all(&encoded)
        .await
        .map_err(|e| format!("write end: {e}"))?;

    // Read FileTransferDone
    loop {
        let n = recv_stream
            .read(&mut read_buf)
            .await
            .map_err(|e| format!("read done: {e}"))?
            .ok_or("stream closed before done")?;
        codec.feed(&read_buf[..n]);
        if let Some(frame) = codec
            .decode_next()
            .map_err(|e| format!("decode done: {e}"))?
        {
            match frame {
                StreamFrame::Control(ControlMessage::FileTransferDone {
                    transfer_id: tid,
                    attachment_id,
                    url,
                }) => {
                    connection.close("upload complete");
                    return Ok(FileTransferResult {
                        transfer_id: tid,
                        attachment_id,
                        url,
                        success: true,
                    });
                }
                StreamFrame::Control(ControlMessage::FileTransferError { message, .. }) => {
                    return Err(format!("upload error: {message}"));
                }
                _ => continue,
            }
        }
    }
}

/// Download a file over a QUIC bidi stream.
pub async fn download_file(
    endpoint_addr: &str,
    token: &str,
    cert_hash: &str,
    attachment_id: &str,
    dest_path: &str,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    use tauri::Emitter;

    // Create a fresh QUIC endpoint
    let bind_addr: std::net::SocketAddr = "0.0.0.0:0"
        .parse()
        .map_err(|e| format!("bad bind addr: {e}"))?;
    let endpoint = MediaEndpoint::client(bind_addr).map_err(|e| format!("endpoint: {e}"))?;

    let remote_addr = NativeMediaSession::resolve_endpoint_addr(endpoint_addr).await?;

    let connecting = endpoint
        .connect_pinned(remote_addr, "paracord", cert_hash)
        .map_err(|e| format!("QUIC connect: {e}"))?;
    let quinn_conn = connecting
        .await
        .map_err(|e| format!("QUIC handshake: {e}"))?;
    let connection = MediaConnection::connect_and_auth(quinn_conn, token, ConnectionMode::Relay)
        .await
        .map_err(|e| format!("auth: {e}"))?;

    // Open bidi stream
    let (mut send_stream, mut recv_stream) = connection
        .open_bi()
        .await
        .map_err(|e| format!("open_bi: {e}"))?;

    // Send FileDownloadRequest
    let req_msg = ControlMessage::FileDownloadRequest {
        attachment_id: attachment_id.to_string(),
        auth_token: token.to_string(),
        range_start: None,
        range_end: None,
    };
    let req_frame = StreamFrame::Control(req_msg);
    let encoded = req_frame.encode().map_err(|e| format!("encode req: {e}"))?;
    send_stream
        .write_all(&encoded)
        .await
        .map_err(|e| format!("write req: {e}"))?;

    // Read FileDownloadAccept
    let mut codec = StreamFrameCodec::new();
    let mut read_buf = vec![0u8; 4096];
    let total_size: u64;

    loop {
        let n = recv_stream
            .read(&mut read_buf)
            .await
            .map_err(|e| format!("read accept: {e}"))?
            .ok_or("stream closed before accept")?;
        codec.feed(&read_buf[..n]);
        if let Some(frame) = codec.decode_next().map_err(|e| format!("decode: {e}"))? {
            match frame {
                StreamFrame::Control(ControlMessage::FileDownloadAccept { size, .. }) => {
                    total_size = size;
                    break;
                }
                StreamFrame::Control(ControlMessage::FileTransferError { message, .. }) => {
                    return Err(format!("download rejected: {message}"));
                }
                _ => continue,
            }
        }
    }

    // Create output file and receive data
    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| format!("create file: {e}"))?;

    let mut bytes_received: u64 = 0;

    loop {
        // Try to decode from existing buffer first
        match codec.decode_next().map_err(|e| format!("decode: {e}"))? {
            Some(StreamFrame::Data(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write file: {e}"))?;
                bytes_received += chunk.len() as u64;

                let _ = app.emit(
                    "file_transfer_progress",
                    serde_json::json!({
                        "transfer_id": attachment_id,
                        "bytes_received": bytes_received,
                        "total_bytes": total_size,
                    }),
                );
                continue;
            }
            Some(StreamFrame::EndOfData) => break,
            Some(StreamFrame::Control(ControlMessage::FileTransferError { message, .. })) => {
                return Err(format!("download error: {message}"));
            }
            Some(_) => continue,
            None => {}
        }

        // Need more data
        let n = recv_stream
            .read(&mut read_buf)
            .await
            .map_err(|e| format!("read data: {e}"))?
            .ok_or("stream closed before EndOfData")?;
        codec.feed(&read_buf[..n]);
    }

    file.flush().await.map_err(|e| format!("flush file: {e}"))?;

    connection.close("download complete");

    Ok(FileTransferResult {
        transfer_id: attachment_id.to_string(),
        attachment_id: Some(attachment_id.to_string()),
        url: None,
        success: true,
    })
}
