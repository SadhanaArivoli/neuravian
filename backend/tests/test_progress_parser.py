"""Unit tests for the tqdm progress line parser."""

import re

import pytest

from app.execution.progress_parser import ParsedProgress, parse_tqdm_line

# Actual FastSurfer log lines from run 21
LINE_BATCH_1 = "  0%|          |   1/256 [02:34<10:57:21, 154.14s/it]"
LINE_BATCH_47 = " 18%|█▊        |  47/256 [2:00:52<8:55:39, 153.87s/it]"
LINE_BATCH_68 = " 27%|██▋       |  68/256 [2:54:08<8:03:20, 154.13s/it]"
LINE_NON_TQDM = "260706-12:34:56,789 nipype.workflow INFO: Running node"


def test_parse_batch_1():
    result = parse_tqdm_line(LINE_BATCH_1)
    assert result is not None
    assert result.percent == 0
    assert result.current == 1
    assert result.total == 256
    assert abs(result.rate - 154.14) < 0.01
    assert result.rate_unit == "it"
    # eta: 10:57:21 = 10*3600 + 57*60 + 21 = 39441
    assert result.eta_seconds == 39441


def test_parse_batch_47():
    result = parse_tqdm_line(LINE_BATCH_47)
    assert result is not None
    assert result.percent == 18
    assert result.current == 47
    assert result.total == 256
    assert abs(result.rate - 153.87) < 0.01
    assert result.rate_unit == "it"


def test_parse_batch_68():
    result = parse_tqdm_line(LINE_BATCH_68)
    assert result is not None
    assert result.percent == 27
    assert result.current == 68
    assert result.total == 256
    # eta: 8:03:20 = 8*3600 + 3*60 + 20 = 29000
    assert result.eta_seconds == 29000


def test_non_tqdm_returns_none():
    result = parse_tqdm_line(LINE_NON_TQDM)
    assert result is None


def test_last_updated_is_iso_utc():
    result = parse_tqdm_line(LINE_BATCH_68)
    assert result is not None
    # Should match ISO 8601 with UTC offset
    iso_pattern = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
    assert re.search(iso_pattern, result.last_updated)


def test_elapsed_parsed_correctly_batch_68():
    result = parse_tqdm_line(LINE_BATCH_68)
    assert result is not None
    # elapsed: 2:54:08 = 2*3600 + 54*60 + 8 = 10448
    assert result.elapsed_seconds == 10448
