import pathlib, shutil
for raw in ['/etc/ssl/certs','/etc/pki/tls/certs','/etc/ca-certificates']:
    path=pathlib.Path(raw)
    if not path.exists(): continue
    temp=path.with_name(path.name+'-materialized')
    shutil.copytree(str(path),str(temp),symlinks=False)
    if path.is_symlink(): path.unlink()
    else: shutil.rmtree(str(path))
    temp.rename(path)
for raw in ['/etc/ssl/cert.pem','/etc/ssl/certs/ca-certificates.crt','/etc/pki/tls/certs/ca-bundle.crt','/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem']:
    path=pathlib.Path(raw)
    if path.is_symlink():
        data=path.read_bytes();path.unlink();path.write_bytes(data);path.chmod(0o644)
