#!/bin/bash
# ===========================================================================
#
# SPDX-FileCopyrightText: © 2020 Alias Developers
# SPDX-FileCopyrightText: © 2016 SpectreCoin Developers
# SPDX-License-Identifier: MIT
#
# ===========================================================================

# Special sed syntax on Mac:
unameOut="$(uname -s)"
backupFileSuffix=''
case "${unameOut}" in
    Darwin*)
        backupFileSuffix='.bak'
        ;;
    *)
        ;;
esac

shopt -s extglob
rm -rf build
mkdir -p build
cp -r assets index.html spectre.qrc build/
find build/ -name README.md -exec rm -f {} \;
sed -i ${backupFileSuffix} 's^"assets^"qrc:///assets^g' build/index.html
sed -i ${backupFileSuffix} 's^"qtwebchannel^"qrc:///qtwebchannel^g' build/index.html
> build/spectre.qrc
IFS=$'\n'

cd build
assets=$(find assets/ -type f|sort)
cd ..

while read line ; do
    echo "$line" >> build/spectre.qrc
    if [[ "$line" == '    <qresource prefix="/">' ]] ; then
        for asset in ${assets} ; do
            echo '        <file alias="'${asset}'">src/qt/res/'${asset}'</file>' >> build/spectre.qrc
        done
    fi
done < spectre.qrc

ALIASES=()
FILES=()
unset IFS
while read line ; do
    [[ "$line" == '<qresource prefix="/">' ]] && RES=true
    [[ "$line" == '</qresource>' ]] && break
    if [[ "$RES" = true ]] ; then
        line=$(echo ${line} | sed 's^<file alias="\(.*\)">.*</file>^\1^')
        ALIASES+=(${line})
        FILES+=("build/${line}")
    fi
done < build/spectre.qrc

for index in ${!FILES[*]} ; do
    file=${FILES[$index]}
    alias=${ALIASES[$index]}
    if [[ ${file} == *".css" ]] && [[ $(fgrep "url(" ${file} -l) ]] ; then
        DIR=$(dirname ${alias})
        PREVDIR=$(dirname ${DIR})
        REPLACE=$(fgrep "url(" ${file} | grep -o 'url(['\''"]\?\([^'\''")]\+\)["'\'']\?)' | sed 's/url(\|["'\'']\|)//g' | sed 's/&/\\&/g')
        for filename in ${REPLACE} ; do
            [[ ${filename} == "qrc:"* ]] && continue
            [[ ${filename} == "data:image"* ]] && continue

            if [[ ${filename} == "../"* ]] ; then
                replacement=$(echo ${filename} | sed 's!^..!qrc:///'${PREVDIR}'!')
#               sed -i ${backupFileSuffix} 's^url(['\''"]\?'${filename}'['\''"]\?)^url('${replacement}')^g' ${file}
                sed -i ${backupFileSuffix} "s^url(['\"]\?${filename}['\"]\?)^url(${replacement})^g" ${file}
            else
                replacement="qrc:///$DIR/$filename"
#               sed -i ${backupFileSuffix} 's^url(['\''"]\?'${filename}'['\''"]\?)^url('${replacement}')^g' ${file}
                sed -i ${backupFileSuffix} "s^url(['\"]\?${filename}['\"]\?)^url(${replacement})^g" ${file}
            fi
        done
        echo ${file}
    fi

    if [[ ${file} == *".js" ]] && [[ $(fgrep "assets" ${file} -l) ]] ; then
        sed -i ${backupFileSuffix} 's^\(assets/\(js\|icons\|img\|plugins\|svg\)\)^qrc:///\1^g' ${file}
        sed -i ${backupFileSuffix} 's^\./qrc:///^qrc:///^g' ${file}
        sed -i ${backupFileSuffix} 's^\(qtwebchannel/\(js\|icons\|img\|plugins\|svg\)\)^qrc:///\1^g' ${file}

        echo ${file}
    fi
done
cd build
tar czf ../alias-ui-assets.tgz.tgz .
cd -
