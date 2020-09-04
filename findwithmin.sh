#!/bin/bash
# ===========================================================================
#
# SPDX-FileCopyrightText: © 2020 Alias Developers
# SPDX-FileCopyrightText: © 2016 SpectreCoin Developers
# SPDX-License-Identifier: MIT
#
# ===========================================================================

FULL=$(find .|grep -e \\\.css$ -e \\\.js$|grep -v ".min.js"|grep -v .min.css)

for file in $FULL ; do
    extension="${file##*.}"
    filename="${file%.*}"

    if [ -f "$filename.min.$extension" ] ; then
        echo "$filename".min."$extension"
    fi
done
