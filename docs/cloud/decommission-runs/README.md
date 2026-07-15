# Decommission run reports

`13-decommission-verify.sh` writes a redacted Markdown report here after a real
deployment is removed. Generated reports are ignored by Git because even a
redacted live report should be reviewed before publication. Machine-readable
reports remain under the ignored `.neuroforge-aws/` state directory.
