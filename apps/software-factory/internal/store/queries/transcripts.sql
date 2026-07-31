-- name: PutTranscript :exec
INSERT INTO transcript (
    run_id, stage, turn, attempt_no,
    compressed_bytes, compression, uncompressed_size_bytes, checksum
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (run_id, stage, turn, attempt_no) DO NOTHING;

-- name: Transcript :one
SELECT * FROM transcript
WHERE run_id = $1 AND stage = $2 AND turn = $3 AND attempt_no = $4;
